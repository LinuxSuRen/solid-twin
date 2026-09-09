// LAS 1.0–1.4 解析（测绘行业标准格式）。
// 支持点格式 0,1,2,3,6,7,8,10（含 RGB / 强度）；LAZ 压缩文件给出转换提示。

const FMT = {
  0: { size: 20, rgb: -1 },
  1: { size: 28, rgb: -1 },
  2: { size: 26, rgb: 20 },
  3: { size: 34, rgb: 28 },
  4: { size: 57, rgb: -1 },
  5: { size: 63, rgb: -1 },
  6: { size: 30, rgb: -1 },
  7: { size: 36, rgb: 30 },
  8: { size: 38, rgb: 30 },
  9: { size: 59, rgb: -1 },
  10: { size: 67, rgb: 30 },
}

export function parseLAS(buf, name, maxPoints = 0) {
  const u8 = new Uint8Array(buf)
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'LASF') throw new Error('不是有效的 LAS 文件')
  const dv = new DataView(buf)
  const verMin = u8[25]
  const globalEncoding = dv.getUint16(6, true)
  const headerSize = dv.getUint16(98, true)
  const offsetToPointData = dv.getUint32(100, true)
  const numVLRs = dv.getUint32(104, true)
  const fmt = u8[108]
  const recLen = dv.getUint16(109, true)
  let count = dv.getUint32(110, true)
  if ((count === 0 || verMin >= 4) && buf.byteLength >= 250) {
    const c64 = Number(dv.getBigUint64(242, true))
    if (c64 > 0 && c64 <= 4.2e9) count = c64
  }
  if (!(fmt in FMT)) throw new Error(`暂不支持 LAS 点格式 ${fmt}（LAZ 请先转 LAS/PLY）`)

  // LAZ 检测：1.4 全局编码 bit0，或存在 laszip VLR
  let laz = (globalEncoding & 0x1) !== 0 && verMin >= 4
  if (!laz) {
    let vpos = headerSize
    for (let i = 0; i < numVLRs; i++) {
      if (vpos + 54 > buf.byteLength) break
      const uid = String.fromCharCode(...u8.subarray(vpos + 2, vpos + 18)).replace(/\0.*$/, '')
      const recLenAfter = dv.getUint16(vpos + 20, true)
      if (uid === 'laszip-encoded') {
        laz = true
        break
      }
      vpos += 54 + recLenAfter
    }
  }
  if (laz) throw new Error('LAZ 压缩文件暂不支持：请用 CloudCompare / las2las (-to_las) 解压后载入')

  const sx = dv.getFloat64(134, true)
  const sy = dv.getFloat64(142, true)
  const sz = dv.getFloat64(150, true)
  const ox = dv.getFloat64(158, true)
  const oy = dv.getFloat64(166, true)
  const oz = dv.getFloat64(174, true)

  count = Math.min(count, Math.floor((buf.byteLength - offsetToPointData) / recLen))
  if (count <= 0) throw new Error('LAS 中没有点数据')

  const { rgb } = FMT[fmt]
  const stride = maxPoints > 0 && count > maxPoints ? Math.ceil(count / maxPoints) : 1
  const cap = Math.ceil(count / stride)
  const positions = new Float32Array(cap * 3)
  const intensities = new Float32Array(cap)
  const colors = rgb >= 0 ? new Float32Array(cap * 3) : null

  // RGB 量程启发式：采样判断 8bit 存储还是 16bit 存储
  let rgbScale = 257 // 16bit → 8bit
  if (colors) {
    let maxV = 0
    const sampleN = Math.min(count, 1000)
    for (let i = 0; i < sampleN; i++) {
      const base = offsetToPointData + i * recLen + rgb
      for (let k = 0; k < 3; k++) maxV = Math.max(maxV, dv.getUint16(base + k * 2, true))
    }
    rgbScale = maxV <= 255 ? 255 : 65535
  }

  let w = 0
  for (let i = 0; i < count; i += stride) {
    const base = offsetToPointData + i * recLen
    positions[w * 3] = dv.getInt32(base, true) * sx + ox
    positions[w * 3 + 1] = dv.getInt32(base + 4, true) * sy + oy
    positions[w * 3 + 2] = dv.getInt32(base + 8, true) * sz + oz
    intensities[w] = dv.getUint16(base + 12, true)
    if (colors) {
      const cbase = base + rgb
      colors[w * 3] = dv.getUint16(cbase, true) / rgbScale
      colors[w * 3 + 1] = dv.getUint16(cbase + 2, true) / rgbScale
      colors[w * 3 + 2] = dv.getUint16(cbase + 4, true) / rgbScale
    }
    w++
  }

  return {
    name,
    positions: new Float32Array(positions.buffer, 0, w * 3),
    intensities: new Float32Array(intensities.buffer, 0, w),
    colors: colors && new Float32Array(colors.buffer, 0, w * 3),
    count: w,
    meta: { originalCount: count, stride },
  }
}
