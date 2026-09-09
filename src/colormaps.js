// 轻量颜色映射工具（无需依赖）

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 经典 Jet 色带：q ∈ [0,1] → [r,g,b] */
export function jet(q) {
  q = clamp01(q)
  return [
    clamp01(1.5 - Math.abs(4 * q - 3)),
    clamp01(1.5 - Math.abs(4 * q - 2)),
    clamp01(1.5 - Math.abs(4 * q - 1)),
  ]
}

const VIRIDIS_STOPS = [
  [0.267004, 0.004874, 0.329415],
  [0.282623, 0.140926, 0.457517],
  [0.253935, 0.265254, 0.529983],
  [0.206756, 0.371758, 0.553117],
  [0.163625, 0.471133, 0.558148],
  [0.127568, 0.566949, 0.550556],
  [0.134692, 0.658636, 0.517649],
  [0.266941, 0.748751, 0.440573],
  [0.477504, 0.821444, 0.318195],
  [0.741388, 0.873449, 0.149561],
  [0.993248, 0.906157, 0.143936],
]

/** Viridis 色带（matplotlib 11 控制点插值） */
export function viridis(q) {
  q = clamp01(q)
  const f = q * (VIRIDIS_STOPS.length - 1)
  const i = Math.min(VIRIDIS_STOPS.length - 2, Math.floor(f))
  const t = f - i
  const a = VIRIDIS_STOPS[i]
  const b = VIRIDIS_STOPS[i + 1]
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** 测站 / 图层调色板 */
export const STATION_COLORS = [
  [0.902, 0.298, 0.294], // #e64b4b
  [0.298, 0.702, 0.314], // #4cb350
  [0.392, 0.486, 0.851], // #647cd9
  [0.961, 0.616, 0.192], // #f59d31
  [0.573, 0.357, 0.706], // #925bb4
  [0.275, 0.765, 0.765], // #46c3c3
  [0.898, 0.369, 0.808], // #e55ece
  [0.686, 0.941, 0.106], // #aff01b
]

/** hex 字符串 → [r,g,b] (0..1) */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
