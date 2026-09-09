// KITTI odometry / semantic-KITTI 格式：每点 4 × float32 (x, y, z, intensity)，小端。
// 大文件在解析期按步长抽稀（maxPoints 预算）。

export function parseKittiBin(buf, name, maxPoints = 0) {
  if (buf.byteLength < 16) throw new Error('文件过小，不是有效的 KITTI bin')
  const totalCount = Math.floor(buf.byteLength / 16)
  const stride = maxPoints > 0 && totalCount > maxPoints ? Math.ceil(totalCount / maxPoints) : 1
  const cap = Math.ceil(totalCount / stride)
  const dv = new DataView(buf)
  const positions = new Float32Array(cap * 3)
  const intensities = new Float32Array(cap)
  let w = 0
  for (let i = 0; i < totalCount; i += stride) {
    const o = i * 16
    const x = dv.getFloat32(o, true)
    const y = dv.getFloat32(o + 4, true)
    const z = dv.getFloat32(o + 8, true)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    positions[w * 3] = x
    positions[w * 3 + 1] = y
    positions[w * 3 + 2] = z
    intensities[w] = dv.getFloat32(o + 12, true)
    w++
  }
  if (!w) throw new Error('KITTI bin 中没有有效点')
  return {
    name,
    positions: new Float32Array(positions.buffer, 0, w * 3),
    intensities: new Float32Array(intensities.buffer, 0, w),
    colors: null,
    count: w,
    meta: { originalCount: totalCount, stride },
  }
}
