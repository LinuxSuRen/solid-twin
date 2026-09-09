// ─────────────────────────────────────────────────────────────
// Livox Mid-360 非重复扫描仿真（纯数学模块，浏览器 / Node 通用）
//
// 视场角：360°(水平) × 59°(垂直, -7° ~ +52°)
// 扫描方式：玫瑰形（rosette）非重复扫描 —— 双频摆线偏转叠加缓慢自旋，
//           积分时间越长覆盖越密集，与 Mid-360 的实际行为一致。
// 输出：按扫描时间顺序排列的点（positions / intensities / stations），
//       可直接送入查看器，或由 Node 脚本导出为 PCD。
// ─────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 合成“数字孪生”场景：仓库房间 + 柱子 + 木箱 + 设备台 + 台阶（解析图元） */
export function makeScene() {
  const boxes = [] // { min:[x,y,z], max:[x,y,z] }
  const cylinders = [] // { cx, cz, y0, r, h }（轴向 = Y）
  const W = 16
  const D = 12
  const H = 4
  const t = 0.25
  boxes.push({ min: [-W / 2, -t, -D / 2], max: [W / 2, 0, D / 2] }) // 地板
  boxes.push({ min: [-W / 2, H, -D / 2], max: [W / 2, H + t, D / 2] }) // 天花板
  boxes.push({ min: [-W / 2 - t, 0, -D / 2 - t], max: [-W / 2, H, D / 2] }) // 墙 x-
  boxes.push({ min: [W / 2, 0, -D / 2 - t], max: [W / 2 + t, H, D / 2] }) // 墙 x+
  boxes.push({ min: [-W / 2, 0, -D / 2 - t], max: [W / 2, H, -D / 2] }) // 墙 z-
  boxes.push({ min: [-W / 2, 0, D / 2], max: [W / 2, H, D / 2 + t] }) // 墙 z+
  cylinders.push({ cx: -3, cz: -2.5, y0: 0, r: 0.4, h: H }) // 柱子 ×2
  cylinders.push({ cx: 3, cz: 2.5, y0: 0, r: 0.4, h: H })
  boxes.push({ min: [1.0, 0, -4.0], max: [2.4, 1.2, -2.8] }) // 木箱堆
  boxes.push({ min: [1.3, 0, -3.7], max: [2.1, 2.0, -3.0] })
  boxes.push({ min: [-5.5, 0, 3.2], max: [-3.9, 0.9, 4.6] })
  boxes.push({ min: [4.6, 0, -5.0], max: [6.6, 1.0, -3.4] }) // 设备台
  boxes.push({ min: [5.0, 1.0, -4.7], max: [6.2, 1.6, -3.8] })
  for (let i = 0; i < 4; i++) {
    // 台阶
    boxes.push({ min: [-6.8, i * 0.25, -1.2 - i * 0.5], max: [-5.6, (i + 1) * 0.25, -0.8 - i * 0.5] })
  }
  return { boxes, cylinders }
}

function rayBox(o, d, box, best) {
  let tmin = 0.02
  let tmax = best
  for (let i = 0; i < 3; i++) {
    const inv = 1 / d[i]
    let t1 = (box.min[i] - o[i]) * inv
    let t2 = (box.max[i] - o[i]) * inv
    if (t1 > t2) {
      const tt = t1
      t1 = t2
      t2 = tt
    }
    if (t1 > tmin) tmin = t1
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return -1
  }
  return tmin
}

function rayCylinder(o, d, c, best) {
  const ox = o[0] - c.cx
  const oz = o[2] - c.cz
  const a = d[0] * d[0] + d[2] * d[2]
  const yTop = c.y0 + c.h
  // 上下盖
  for (const yPlane of [c.y0, yTop]) {
    if (d[1] !== 0) {
      const tp = (yPlane - o[1]) / d[1]
      if (tp > 0.02 && tp < best) {
        const px = ox + tp * d[0]
        const pz = oz + tp * d[2]
        if (px * px + pz * pz <= c.r * c.r) return tp
      }
    }
  }
  if (a < 1e-9) return -1
  const b = 2 * (ox * d[0] + oz * d[2])
  const cc = ox * ox + oz * oz - c.r * c.r
  const disc = b * b - 4 * a * cc
  if (disc < 0) return -1
  const sq = Math.sqrt(disc)
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t > 0.02 && t < best) {
      const y = o[1] + t * d[1]
      if (y >= c.y0 && y <= yTop) return t
    }
  }
  return -1
}

export function intersectScene(o, d, scene) {
  let best = Infinity
  for (const b of scene.boxes) {
    const t = rayBox(o, d, b, best)
    if (t > 0 && t < best) best = t
  }
  for (const c of scene.cylinders) {
    const t = rayCylinder(o, d, c, best)
    if (t > 0 && t < best) best = t
  }
  return best === Infinity ? -1 : best
}

/**
 * 生成玫瑰形非重复扫描方向序列（生成器，按时间顺序）。
 * 双频摆线（w1,w2 略有差异 → 花瓣进动）+ 绕 Z 缓慢自旋 → 360° 覆盖。
 */
export function* mid360ScanDirections({ duration = 10, rate = 20000, seed = 1 }) {
  const TAU = Math.PI * 2
  const w1 = TAU * 15.0
  const w2 = TAU * 13.7
  const spin = TAU * 0.9 // 自旋速度（圈/秒）
  const R = 0.515 // 最大偏转角 ≈ 29.5°
  const elC = (22.5 * Math.PI) / 180 // 垂直 FOV 中心仰角
  const elMin = (-7 * Math.PI) / 180
  const elMax = (52 * Math.PI) / 180
  const dt = 1 / rate
  const n = Math.floor(duration * rate)
  for (let i = 0; i < n; i++) {
    const t = i * dt
    const dEl = R * (0.62 * Math.cos(w1 * t) + 0.38 * Math.cos(w2 * t))
    const dAz = R * (0.62 * Math.sin(w1 * t) + 0.38 * Math.sin(w2 * t))
    const el = elC + dEl
    if (el < elMin || el > elMax) continue // 超出垂直 FOV
    const az = spin * t + dAz
    yield { az, el, t }
  }
}

/** 默认三个测站（模拟 FAST-LIO2 建图后多站配准拼接） */
export function defaultStations() {
  return [
    { pos: [-4, 1.3, -2], yaw: 0.4 },
    { pos: [4.2, 1.3, 2.2], yaw: 2.6 },
    { pos: [0, 1.3, 4.4], yaw: 4.5 },
  ]
}

/**
 * 对合成场景执行多站 Mid-360 扫描，返回归一化点云数据。
 * 点按扫描时间顺序排列 → 查看器可做“逐点回放”动画。
 */
export function generateMid360Cloud({ stations = defaultStations(), duration = 10, rate = 20000, noise = 0.004, seed = 42 } = {}) {
  const scene = makeScene()
  const pos = []
  const inten = []
  const st = []
  stations.forEach((s, si) => {
    const cosY = Math.cos(s.yaw)
    const sinY = Math.sin(s.yaw)
    const rnd = mulberry32(seed + si * 977)
    for (const { az, el } of mid360ScanDirections({ duration, rate, seed: seed + si })) {
      const cEl = Math.cos(el)
      // 扫描器坐标系：x 前、y 上、z 右（任意但保持一致）
      const dx = cEl * Math.sin(az)
      const dy = Math.sin(el)
      const dz = cEl * Math.cos(az)
      const rx = dx * cosY + dz * sinY
      const rz = -dx * sinY + dz * cosY
      const t = intersectScene(s.pos, [rx, dy, rz], scene)
      if (t <= 0) continue
      // 测距噪声：比例项 + 固定项（≈ ±2cm @10m）
      const noisy = t * (1 + (rnd() - 0.5) * 0.002) + (rnd() - 0.5) * noise
      pos.push(s.pos[0] + rx * noisy, s.pos[1] + dy * noisy, s.pos[2] + rz * noisy)
      const falloff = Math.max(0.15, 1 - t / 28)
      inten.push(falloff * (0.72 + 0.56 * rnd()))
      st.push(si)
    }
  })
  return {
    positions: new Float32Array(pos),
    intensities: new Float32Array(inten),
    stations: new Uint8Array(st),
    count: pos.length / 3,
    meta: { stations: stations.length, duration, rate, pointsPerStation: Math.round((pos.length / 3) / stations.length) },
  }
}
