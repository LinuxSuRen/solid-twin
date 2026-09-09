// ─────────────────────────────────────────────────────────────
// TwinViewer：基于 Three.js 的点云数字孪生查看器
//  · 多图层（模拟扫描 / 外部文件）
//  · 着色模式：高程 / 强度 / 原始 RGB / 测站
//  · 点数抽稀（索引步长）、逐点扫描回放、视图适配、截图
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { jet, viridis, STATION_COLORS } from './colormaps.js'
import { DeviceLayer } from './devices.js'

const BG_DARK = 0x0b0d10
const BG_LIGHT = 0xe8eaef

/** 取整到 1/2/5×10^n 的“好看”刻度 */
function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-9))))
  for (const m of [1, 2, 5, 10]) {
    if (m * p >= v) return m * p
  }
  return 10 * p
}

function circleTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.75, 'rgba(255,255,255,1)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.beginPath()
  g.arc(32, 32, 32, 0, Math.PI * 2)
  g.fill()
  return new THREE.CanvasTexture(c)
}

export class TwinViewer {
  constructor(container, opts = {}) {
    this.container = container
    this.onStats = opts.onStats || (() => {})
    this.onReplay = opts.onReplay || (() => {})
    this.onPick = opts.onPick || (() => {})
    this.colorMode = 'height'
    this.layers = new Map()
    this.layerSeq = 0
    this.replay = { playing: false, rate: 25000, mult: 1 }
    this._fly = null
    this._raycaster = new THREE.Raycaster()

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BG_DARK)

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 3000)
    this.camera.position.set(11, 8, 13)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxDistance = 1000
    this.controls.target.set(0, 1.2, 0)

    this.pointTexture = circleTexture()
    this.pointsGroup = new THREE.Group()
    this.scene.add(this.pointsGroup)

    // 设备语义图层（数字孪生锚点）
    this.deviceLayer = new DeviceLayer(this.scene)

    // 点击拾取（区分拖拽旋转）
    this._down = null
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this._down = { x: e.clientX, y: e.clientY, b: e.button, t: performance.now() }
    })
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      const d = this._down
      this._down = null
      if (!d || d.b !== 0 || performance.now() - d.t > 600) return
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (dx * dx + dy * dy > 36) return
      this._handleClick(e)
    })

    this.grid = new THREE.GridHelper(60, 60, 0x3a4656, 0x222a35)
    this._gridOn = true
    this._gridWorld = 60
    this.scene.add(this.grid)
    this.axes = new THREE.AxesHelper(2.2)
    this.axes.position.y = 0.011
    this.scene.add(this.axes)

    this._resize()
    this._ro = new ResizeObserver(() => this._resize())
    this._ro.observe(container)

    this.clock = new THREE.Clock()
    this._frames = 0
    this._statAcc = 0
    this._loopBound = this._loop.bind(this)
    this._raf = requestAnimationFrame(this._loopBound)
  }

  // ── 图层管理 ───────────────────────────────

  addLayer(d) {
    const id = ++this.layerSeq
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(d.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(d.count * 3), 3))
    const fullIndex = new Uint32Array(d.count)
    for (let i = 0; i < d.count; i++) fullIndex[i] = i
    geo.setIndex(new THREE.BufferAttribute(fullIndex, 1))

    const mat = new THREE.PointsMaterial({
      size: 0.025,
      vertexColors: true,
      map: this.pointTexture,
      alphaTest: 0.4,
      sizeAttenuation: true,
    })
    const pts = new THREE.Points(geo, mat)
    pts.frustumCulled = false
    this.pointsGroup.add(pts)

    const layer = {
      id,
      name: d.name || `图层 ${id}`,
      data: d,
      points: pts,
      geometry: geo,
      material: mat,
      visible: true,
      progress: 1, // 回放进度 0..1
      indexCount: d.count,
      idxScratch: fullIndex,
      box: this._boxOf(d.positions, d.count),
    }
    this.layers.set(id, layer)
    this.setDecimation(this.decimation ?? 1)
    this.applyColorMode(this.colorMode)
    this._fitHelpers()
    return id
  }

  removeLayer(id) {
    const l = this.layers.get(id)
    if (!l) return
    this.pointsGroup.remove(l.points)
    l.geometry.dispose()
    l.material.dispose()
    this.layers.delete(id)
    this.applyColorMode(this.colorMode)
    this._fitHelpers()
  }

  /** 图层数据被原地修改（重定向/重居中）后刷新几何、包围盒与配色 */
  refreshLayer(id) {
    const l = this.layers.get(id)
    if (!l) return
    const attr = l.geometry.attributes.position
    if (attr && attr.array === l.data.positions) {
      attr.needsUpdate = true
    } else {
      l.geometry.setAttribute('position', new THREE.BufferAttribute(l.data.positions, 3))
    }
    l.box = this._boxOf(l.data.positions, l.data.count)
    this.applyColorMode(this.colorMode)
    this._fitHelpers()
  }

  setLayerVisible(id, v) {
    const l = this.layers.get(id)
    if (!l) return
    l.visible = v
    l.points.visible = v
    this.applyColorMode(this.colorMode)
  }

  clearLayers() {
    for (const id of [...this.layers.keys()]) this.removeLayer(id)
  }

  // ── 显示控制 ───────────────────────────────

  setPointSize(s) {
    for (const l of this.layers.values()) l.material.size = s
  }

  setDecimation(f) {
    this.decimation = f
    const stride = Math.max(1, Math.round(1 / f))
    for (const l of this.layers.values()) {
      const n = Math.ceil(l.data.count / stride)
      const idx = l.idxScratch
      for (let i = 0; i < n; i++) idx[i] = i * stride
      l.indexCount = n
      l.geometry.setIndex(new THREE.BufferAttribute(idx.subarray(0, n), 1))
      l.geometry.setDrawRange(0, Math.ceil(n * l.progress))
    }
  }

  applyColorMode(mode = this.colorMode) {
    this.colorMode = mode
    let zmin = Infinity
    let zmax = -Infinity
    for (const l of this.layers.values()) {
      if (!l.visible) continue
      zmin = Math.min(zmin, l.box.min.y)
      zmax = Math.max(zmax, l.box.max.y)
    }
    if (!Number.isFinite(zmin)) {
      zmin = 0
      zmax = 1
    }
    if (zmax - zmin < 1e-6) zmax = zmin + 1

    let li = 0
    for (const l of this.layers.values()) {
      const d = l.data
      const col = l.geometry.attributes.color.array
      const useRGB = mode === 'rgb' && d.colors
      const useInt = mode === 'intensity' && d.intensities

      if (mode === 'height') {
        const range = zmax - zmin
        for (let i = 0; i < d.count; i++) {
          const c = jet((d.positions[i * 3 + 1] - zmin) / range)
          col[i * 3] = c[0]
          col[i * 3 + 1] = c[1]
          col[i * 3 + 2] = c[2]
        }
      } else if (useInt) {
        let imin = Infinity
        let imax = -Infinity
        for (let i = 0; i < d.count; i++) {
          const v = d.intensities[i]
          if (v < imin) imin = v
          if (v > imax) imax = v
        }
        if (imax - imin < 1e-9) imax = imin + 1
        const range = imax - imin
        for (let i = 0; i < d.count; i++) {
          const c = viridis((d.intensities[i] - imin) / range)
          col[i * 3] = c[0]
          col[i * 3 + 1] = c[1]
          col[i * 3 + 2] = c[2]
        }
      } else if (useRGB) {
        col.set(d.colors.subarray(0, d.count * 3))
      } else {
        // 测站 / 图层着色（含各类回退）
        const base = STATION_COLORS[li % STATION_COLORS.length]
        const st = d.stations
        for (let i = 0; i < d.count; i++) {
          const c = st ? STATION_COLORS[st[i] % STATION_COLORS.length] : base
          col[i * 3] = c[0]
          col[i * 3 + 1] = c[1]
          col[i * 3 + 2] = c[2]
        }
      }
      l.geometry.attributes.color.needsUpdate = true
      li++
    }
  }

  // ── 回放 ───────────────────────────────────

  startReplay(rate = 25000) {
    this.replay.rate = rate
    this.replay.playing = true
    for (const l of this.layers.values()) l.progress = 0
    this._emitReplay()
  }

  pauseReplay() {
    this.replay.playing = false
  }

  resumeReplay() {
    if (this._replayDone()) this.startReplay(this.replay.rate)
    else this.replay.playing = true
  }

  isPlaying() {
    return this.replay.playing
  }

  setReplaySpeed(mult) {
    this.replay.mult = mult
  }

  _replayDone() {
    let done = true
    for (const l of this.layers.values()) {
      if (l.visible && l.progress < 1) done = false
    }
    return done
  }

  _emitReplay() {
    let sum = 0
    let n = 0
    for (const l of this.layers.values()) {
      if (!l.visible) continue
      sum += l.progress
      n++
    }
    this.onReplay(n ? sum / n : 1, this.replay.playing)
  }

  // ── 视图 ───────────────────────────────────

  _visibleBox() {
    const box = new THREE.Box3()
    let any = false
    for (const l of this.layers.values()) {
      if (!l.visible) continue
      box.union(l.box)
      any = true
    }
    return any ? box : null
  }

  _boxOf(positions, count) {
    const box = new THREE.Box3()
    const v = new THREE.Vector3()
    for (let i = 0; i < count; i++) {
      v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
      box.expandByPoint(v)
    }
    return box
  }

  /** 网格与坐标轴自适应场景尺寸（全部图层并集，不随显隐抖动） */
  _fitHelpers() {
    const box = new THREE.Box3()
    let any = false
    for (const l of this.layers.values()) {
      box.union(l.box)
      any = true
    }
    const size = any ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(20, 4, 20)
    const maxDim = Math.max(size.x, size.y, size.z, 1)
    const world = niceCeil(maxDim * 1.5)
    if (world !== this._gridWorld) {
      this._gridWorld = world
      const step = niceCeil(world / 10)
      const divisions = Math.max(1, Math.min(400, Math.round(world / step)))
      this.scene.remove(this.grid)
      this.grid.dispose?.()
      this.grid = new THREE.GridHelper(world, divisions, 0x3a4656, 0x222a35)
      this.grid.visible = this._gridOn
      this.scene.add(this.grid)
    }
    this.axes.scale.setScalar(Math.min(25, Math.max(0.5, maxDim * 0.05)))
    this.deviceLayer?.setMarkerScale(Math.min(6, Math.max(0.4, maxDim * 0.022)))
  }

  fitView() {
    const box = this._visibleBox()
    if (!box) return
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z, 0.5)
    const dist = (maxDim / 2 / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.35
    const dir = this.camera.position.clone().sub(this.controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.7, 1)
    dir.normalize()
    this.camera.position.copy(center).addScaledVector(dir, dist)
    this.controls.target.copy(center)
    this.camera.near = Math.max(0.02, dist / 1000)
    this.camera.far = Math.max(2000, dist * 30)
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  topView() {
    const box = this._visibleBox()
    const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3()
    const dist = this.camera.position.distanceTo(this.controls.target) || 15
    this.camera.position.set(center.x, center.y + dist, center.z + 0.001 * dist)
    this.controls.target.copy(center)
    this.controls.update()
  }

  isoView() {
    const box = this._visibleBox()
    const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3()
    const dist = this.camera.position.distanceTo(this.controls.target) || 15
    this.camera.position.set(center.x + dist * 0.61, center.y + dist * 0.5, center.z + dist * 0.61)
    this.controls.target.copy(center)
    this.controls.update()
  }

  setGrid(v) {
    this._gridOn = v
    this.grid.visible = v
  }

  setAxes(v) {
    this.axes.visible = v
  }

  setLightBackground(v) {
    this.scene.background = new THREE.Color(v ? BG_LIGHT : BG_DARK)
  }

  screenshot(filename = 'solid-twin.png') {
    this.renderer.render(this.scene, this.camera)
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
    })
  }

  // ── 拾取与定位 ─────────────────────────────

  _handleClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this._raycaster.setFromCamera(ndc, this.camera)
    const device = this.deviceLayer.pick(this._raycaster)
    if (device) return this.onPick({ device })
    const hit = this.pickNearestPoint(this._raycaster, 3)
    this.onPick(hit ? { point: { x: hit.x, y: hit.y, z: hit.z, data: hit.data } } : {})
  }

  /** 屏幕射线 → 点云最近点（步进扫描，千万点级 ~100ms，仅点击时执行） */
  pickNearestPoint(raycaster, stride = 3) {
    const ray = raycaster.ray
    let best = null
    for (const l of this.layers.values()) {
      if (!l.visible) continue
      const p = l.data.positions
      const n = l.data.count
      for (let i = 0; i < n; i += stride) {
        const wx = p[i * 3] - ray.origin.x
        const wy = p[i * 3 + 1] - ray.origin.y
        const wz = p[i * 3 + 2] - ray.origin.z
        const proj = wx * ray.direction.x + wy * ray.direction.y + wz * ray.direction.z
        if (proj < 0.2) continue
        const d2 = wx * wx + wy * wy + wz * wz - proj * proj
        const tol = Math.max(0.4, proj * 0.012) // 屏幕拾取容差随距离缩放
        if (d2 < tol * tol && (!best || d2 < best.d2)) {
          best = { d2, x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2], data: l.data }
        }
      }
    }
    return best
  }

  /** 相机平滑飞行到目标（数组 [x,y,z] 或 Vector3） */
  flyTo(pos, dist) {
    const t = Array.isArray(pos) ? new THREE.Vector3(pos[0], pos[1], pos[2]) : pos.clone()
    const d = dist ?? Math.max(5, this.camera.position.distanceTo(this.controls.target) * 0.3)
    const dir = this.camera.position.clone().sub(this.controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.7, 1)
    dir.normalize()
    this._fly = {
      p0: this.camera.position.clone(),
      t0: this.controls.target.clone(),
      p1: t.clone().addScaledVector(dir, d),
      t1: t,
      s: performance.now(),
      dur: 700,
    }
    this.controls.enabled = false
  }

  // ── 渲染循环 ───────────────────────────────

  _resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h) // 同步 CSS 尺寸，修复 Retina 下画布 2x 溢出
    this.camera.aspect = w / h
    this._applyViewOffset()
    this.camera.updateProjectionMatrix()
  }

  /**
   * 设置取景内边距（左侧面板遮挡宽度，px）：
   * 通过负偏移的 setViewOffset 把投影中心移到“可见区域”的几何中心，
   * 点云在视觉上居中于面板右侧，而不是整个窗口。
   */
  setViewportInset(left = 0, top = 0) {
    this._inset = { left, top }
    this._applyViewOffset()
    this.camera.updateProjectionMatrix()
  }

  _applyViewOffset() {
    const ins = this._inset
    if (ins && (ins.left > 0 || ins.top > 0)) {
      const w = this.container.clientWidth || 1
      const h = this.container.clientHeight || 1
      this.camera.setViewOffset(w, h, -ins.left / 2, -ins.top / 2, w, h)
    } else if (this.camera.view?.enabled) {
      this.camera.clearViewOffset()
    }
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loopBound)
    const dt = Math.min(this.clock.getDelta(), 0.1)

    // 相机飞行补间
    if (this._fly) {
      const k = Math.min(1, (performance.now() - this._fly.s) / this._fly.dur)
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      this.camera.position.lerpVectors(this._fly.p0, this._fly.p1, e)
      this.controls.target.lerpVectors(this._fly.t0, this._fly.t1, e)
      if (k >= 1) {
        this._fly = null
        this.controls.enabled = true
      }
    }
    this.controls.update()
    this.deviceLayer?.update(this.clock.elapsedTime)

    if (this.replay.playing) {
      let allDone = true
      const advance = this.replay.rate * this.replay.mult * dt
      for (const l of this.layers.values()) {
        if (!l.visible) continue
        if (l.progress < 1) {
          l.progress = Math.min(1, l.progress + advance / Math.max(1, l.indexCount))
          if (l.progress < 1) allDone = false
        }
        l.geometry.setDrawRange(0, Math.ceil(l.indexCount * l.progress))
      }
      if (allDone) this.replay.playing = false
      this._emitReplay()
    }

    this.renderer.render(this.scene, this.camera)

    this._frames++
    this._statAcc += dt
    if (this._statAcc >= 0.5) {
      let total = 0
      let drawn = 0
      for (const l of this.layers.values()) {
        if (!l.visible) continue
        total += l.data.count
        drawn += Math.min(l.indexCount, Math.ceil(l.indexCount * l.progress))
      }
      this.onStats({
        fps: Math.round(this._frames / this._statAcc),
        total,
        drawn,
      })
      this._frames = 0
      this._statAcc = 0
    }
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    this._ro.disconnect()
    this.clearLayers()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
