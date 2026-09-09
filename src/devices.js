// ─────────────────────────────────────────────────────────────
// DeviceLayer：设备语义图层（数字孪生的“实体锚点”）
//
//  · 设备 = { id, name, type, position(原始文件坐标), radius, file(来源图层名) }
//    ID 是唯一关联键：对接 MQTT/OPC UA tag、glTF 节点名、台账系统
//  · position 存「原始文件坐标」，显示时经 originalToView 应用与点云
//    相同的变换 → 重定向/重导入后锚点始终贴合
//  · 告警状态机：normal → info / warn / alarm，驱动标记变色 + 脉冲 + 标签
//  · 拾取：标记 Sprite 直接 raycast；点云点击可按半径关联设备
// ─────────────────────────────────────────────────────────────

import * as THREE from 'three'
import { originalToView } from './orientation.js'

export const LEVEL_COLORS = { normal: '#4ea1ff', info: '#35c3c8', warn: '#f5a623', alarm: '#e64b4b' }

function drawMarkerTexture(color, level) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const hex = color.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const gr = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const grad = g.createRadialGradient(64, 64, 10, 64, 64, 62)
  grad.addColorStop(0, `rgba(${r},${gr},${b},0.85)`)
  grad.addColorStop(0.55, `rgba(${r},${gr},${b},0.22)`)
  grad.addColorStop(1, `rgba(${r},${gr},${b},0)`)
  g.fillStyle = grad
  g.beginPath()
  g.arc(64, 64, 62, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = color
  g.beginPath()
  g.arc(64, 64, 20, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#fff'
  g.beginPath()
  g.arc(64, 64, 12, 0, Math.PI * 2)
  g.fill()
  if (level === 'warn' || level === 'alarm') {
    g.fillStyle = color
    g.font = 'bold 26px sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('!', 64, 66)
  }
  const tex = new THREE.CanvasTexture(c)
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function drawLabelTexture(text, color) {
  const pad = 14
  const h = 46
  const c = document.createElement('canvas')
  const g = c.getContext('2d')
  g.font = '600 26px "PingFang SC", "Microsoft YaHei", sans-serif'
  const w = Math.ceil(g.measureText(text).width) + pad * 2
  c.width = w
  c.height = h
  g.font = '600 26px "PingFang SC", "Microsoft YaHei", sans-serif'
  g.fillStyle = 'rgba(10,14,20,0.85)'
  g.beginPath()
  g.roundRect(0.5, 0.5, w - 1, h - 1, 9)
  g.fill()
  g.strokeStyle = color
  g.lineWidth = 2
  g.stroke()
  g.fillStyle = '#f0f4f9'
  g.textBaseline = 'middle'
  g.textAlign = 'left'
  g.fillText(text, pad, h / 2 + 1)
  const tex = new THREE.CanvasTexture(c)
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export class DeviceLayer {
  constructor(scene) {
    this.scene = scene
    this.devices = new Map()
    this.group = new THREE.Group()
    this.markerScale = 1
    this.resolver = null // (device) → 所属图层数据（提供变换），null 则视为视图坐标
    scene.add(this.group)
  }

  setMarkerScale(s) {
    this.markerScale = s
    for (const d of this.devices.values()) d.group.scale.setScalar(s)
  }

  setResolver(fn) {
    this.resolver = fn
    this.syncAll()
  }

  addDevice({ id, name, type = '设备', position, radius = 2, file = null }) {
    if (!id || !position) throw new Error('设备需要 id 与 position')
    if (this.devices.has(id)) throw new Error(`设备 ID 重复：${id}`)
    const group = new THREE.Group()
    group.scale.setScalar(this.markerScale)

    const device = {
      id,
      name: name || id,
      type,
      position: [...position], // 原始文件坐标
      radius,
      file,
      alarm: null,
      group,
      marker: null,
      label: null,
      viewPosition: null,
      phase: Math.random() * Math.PI * 2,
    }
    this._updateViewPosition(device, true)
    this._styleDevice(device)
    this.group.add(group)
    this.devices.set(id, device)
    return device
  }

  /** 依据来源图层的变换刷新视图位置；无变换/无来源时按视图坐标处理 */
  _updateViewPosition(device, force = false) {
    const layerData = this.resolver ? this.resolver(device) : null
    if (layerData) {
      const out = [0, 0, 0]
      originalToView(layerData, device.position[0], device.position[1], device.position[2], out)
      device.viewPosition = [...out]
    } else if (force || !device.viewPosition) {
      device.viewPosition = [...device.position]
    }
    device.group.position.set(device.viewPosition[0], device.viewPosition[1], device.viewPosition[2])
  }

  /** 朝向/变换变化后同步全部锚点 */
  syncAll() {
    for (const d of this.devices.values()) this._updateViewPosition(d)
  }

  /** 依据告警状态重建标记与标签外观 */
  _styleDevice(device) {
    const level = device.alarm?.level || 'normal'
    const color = LEVEL_COLORS[level] || LEVEL_COLORS.normal
    if (device.marker) {
      device.group.remove(device.marker)
      device.marker.material.map.dispose()
      device.marker.material.dispose()
    }
    const marker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: drawMarkerTexture(color, level), depthTest: false, transparent: true }),
    )
    marker.renderOrder = 999
    marker.userData.deviceId = device.id
    device.group.add(marker)
    device.marker = marker

    const labelText = device.alarm
      ? `${device.name} · ${device.alarm.message || level}`
      : `${device.name} · ${device.id}`
    if (device.label) {
      device.group.remove(device.label)
      device.label.material.map.dispose()
      device.label.material.dispose()
    }
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: drawLabelTexture(labelText, color), depthTest: false, transparent: true }),
    )
    label.renderOrder = 1000
    const aspect = label.material.map.image.width / label.material.map.image.height
    label.scale.set(aspect * 0.9, 0.9, 1)
    label.position.y = 1.15
    label.visible = !!device.alarm
    device.group.add(label)
    device.label = label
  }

  removeDevice(id) {
    const d = this.devices.get(id)
    if (!d) return
    this.group.remove(d.group)
    d.marker?.material.map.dispose()
    d.marker?.material.dispose()
    d.label?.material.map.dispose()
    d.label?.material.dispose()
    this.devices.delete(id)
  }

  load(list) {
    for (const id of [...this.devices.keys()]) this.removeDevice(id)
    for (const item of list || []) this.addDevice(item)
  }

  serialize() {
    return [...this.devices.values()].map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      position: d.position, // 原始文件坐标
      radius: d.radius,
      file: d.file,
    }))
  }

  /** 设置/更新告警。level: info | warn | alarm；返回设备（未找到返回 null） */
  setAlarm(id, level, message) {
    const d = this.devices.get(id)
    if (!d) return null
    d.alarm = { level, message: message || '', since: Date.now() }
    this._styleDevice(d)
    return d
  }

  clearAlarm(id) {
    const d = this.devices.get(id)
    if (!d || !d.alarm) return null
    d.alarm = null
    this._styleDevice(d)
    return d
  }

  clearAllAlarms() {
    for (const d of this.devices.values()) {
      if (d.alarm) {
        d.alarm = null
        this._styleDevice(d)
      }
    }
  }

  /** 直接拾取标记 Sprite */
  pick(raycaster) {
    const targets = []
    for (const d of this.devices.values()) targets.push(d.marker)
    const hits = raycaster.intersectObjects(targets, false)
    return hits.length ? this.devices.get(hits[0].object.userData.deviceId) : null
  }

  /** 视图坐标附近 radius+extra 内的设备（点云点击 → 设备关联） */
  findNear(x, y, z, extra = 0) {
    let best = null
    let bestD = Infinity
    for (const d of this.devices.values()) {
      const p = d.viewPosition
      const dist = Math.hypot(x - p[0], y - p[1], z - p[2])
      if (dist < d.radius + extra && dist < bestD) {
        best = d
        bestD = dist
      }
    }
    return best
  }

  /** 告警脉冲动画（由查看器渲染循环驱动） */
  update(t) {
    for (const d of this.devices.values()) {
      if (d.alarm) {
        const pulse = 1 + 0.16 * Math.sin(t * 7 + d.phase)
        d.group.scale.setScalar(this.markerScale * pulse)
      } else if (d.group.scale.x !== this.markerScale) {
        d.group.scale.setScalar(this.markerScale)
      }
    }
  }
}
