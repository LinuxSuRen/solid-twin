// 通用文本点云（XYZ / TXT / CSV / ASC / PTS）解析。
// 自动识别列布局：
//   3 列 → x y z           4 列 → x y z intensity
//   6 列 → x y z r g b     7 列 → x y z intensity r g b
// RGB 量程自动判断（0-1 或 0-255）。支持 # 注释与空行。

export function parseXYZ(buf, name, maxPoints = 0) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  const lines = text.split(/\r?\n/)

  // 推断列布局
  let ncols = 0
  let probe = null
  for (const line of lines) {
    const s = line.trim()
    if (!s || s.startsWith('#') || s.startsWith('//')) continue
    const tok = s.split(/[\s,;]+/)
    const nums = tok.map(Number)
    if (nums.length >= 3 && nums.slice(0, 3).every((v) => Number.isFinite(v))) {
      ncols = Math.min(nums.length, 7)
      probe = nums
      break
    }
  }
  if (!probe) throw new Error('无法识别的文本点云格式（前几行没有 3 个以上数字）')

  const hasI = ncols === 4 || ncols === 7
  const hasC = ncols >= 6
  // RGB 量程探测
  let colorScale = 255
  if (hasC) {
    let maxV = 0
    let checked = 0
    for (const line of lines) {
      if (checked > 500) break
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const tok = s.split(/[\s,;]+/)
      if (tok.length < 6) continue
      for (let k = 3 + (ncols === 7 ? 1 : 0); k < 6 + (ncols === 7 ? 1 : 0); k++) {
        const v = +tok[k]
        if (Number.isFinite(v)) maxV = Math.max(maxV, v)
      }
      checked++
    }
    colorScale = maxV <= 1.0001 ? 1 : 255
  }

  const pos = []
  const inten = []
  const col = []
  let bad = 0
  const strideGuess = maxPoints > 0 && lines.length > maxPoints * 3 ? Math.ceil(lines.length / maxPoints) : 1
  let lineNo = 0
  for (const line of lines) {
    lineNo++
    if (lineNo % strideGuess && strideGuess > 1) continue // 解析期抽稀
    const s = line.trim()
    if (!s || s.startsWith('#') || s.startsWith('//')) continue
    const tok = s.split(/[\s,;]+/)
    if (tok.length < 3) continue
    const x = +tok[0]
    const y = +tok[1]
    const z = +tok[2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      bad++
      continue
    }
    pos.push(x, y, z)
    if (hasI) inten.push(+(tok[3] || 0))
    if (hasC) {
      const off = ncols === 7 ? 4 : 3
      col.push(
        Math.max(0, Math.min(255, +tok[off] || 0)) / colorScale,
        Math.max(0, Math.min(255, +tok[off + 1] || 0)) / colorScale,
        Math.max(0, Math.min(255, +tok[off + 2] || 0)) / colorScale,
      )
    }
  }
  const count = pos.length / 3
  if (!count) throw new Error('文本点云中没有有效点')
  if (bad > count * 0.3) console.warn('[xyz] 跳过了较多无效行:', bad)

  return {
    name,
    positions: new Float32Array(pos),
    intensities: hasI ? new Float32Array(inten) : null,
    colors: hasC ? new Float32Array(col) : null,
    count,
    meta: { originalCount: count, stride: strideGuess },
  }
}
