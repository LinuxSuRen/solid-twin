// PCD (Point Cloud Data, PCL 格式) 解析：支持 ascii 与 binary，
// binary_compressed (LZF) 给出明确提示。
// 兼容 FAST-LIO2 / Point-LIO 等输出的 x y z intensity [rgb] 布局。
//
// 关键点：
//  · DATA 行按“行首 token”定位——标准注释 “... Cloud Data file format”
//    中也含 "Data"，绝不能用 indexOf('DATA ') 找数据起点
//  · 大文件（千万点级）在解析期即按步长抽稀，避免先物化数百 MB 中间数组
//  · 跳过 NaN/Inf 点（部分导出工具会写入无效点）

const TEXT = new TextDecoder()

function readBin(dv, offset, size, type) {
  switch (type) {
    case 'F':
      return size === 8 ? dv.getFloat64(offset, true) : dv.getFloat32(offset, true)
    case 'U':
      return size === 1 ? dv.getUint8(offset) : size === 2 ? dv.getUint16(offset, true) : dv.getUint32(offset, true)
    case 'I':
      return size === 1 ? dv.getInt8(offset) : size === 2 ? dv.getInt16(offset, true) : dv.getInt32(offset, true)
    default:
      return NaN
  }
}

export function parsePCD(buf, name, maxPoints = 0) {
  const headText = TEXT.decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 8192)))
  const lines = headText.split(/\r?\n/)
  const meta = { fields: [], size: [], type: [], count: [] }
  let dataMode = null
  let dataStart = 0

  // 逐行解析头部，同时累计字节偏移（\r\n / \n 均正确处理）
  let off = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineEnd = off + line.length
    const sepLen = headText.slice(lineEnd, lineEnd + 2) === '\r\n' ? 2 : 1
    const next = lineEnd + sepLen
    if (line && !line.startsWith('#')) {
      const parts = line.trim().split(/\s+/)
      const key = (parts[0] || '').toUpperCase()
      if (key === 'DATA') {
        dataMode = (parts[1] || '').toLowerCase()
        dataStart = next
        break
      }
      if (key === 'FIELDS') meta.fields = parts.slice(1)
      else if (key === 'SIZE') meta.size = parts.slice(1).map(Number)
      else if (key === 'TYPE') meta.type = parts.slice(1)
      else if (key === 'COUNT') meta.count = parts.slice(1).map(Number)
      else if (key === 'POINTS') meta.points = Number(parts[1]) || 0
    }
    off = next
  }
  if (!dataMode) throw new Error('PCD 头部缺少 DATA 声明')
  if (dataMode === 'binary_compressed') {
    throw new Error('PCD binary_compressed (LZF) 暂不支持：请用 pcl_convert_pcd_ascii_binary 或 CloudCompare 转存为 ascii/binary')
  }

  const f = meta.fields.map((s) => s.toLowerCase())
  const ix = f.indexOf('x')
  const iy = f.indexOf('y')
  const iz = f.indexOf('z')
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PCD 缺少 x/y/z 字段')
  const iInt = f.indexOf('intensity')
  const iRGB = f.indexOf('rgb') >= 0 ? f.indexOf('rgb') : f.indexOf('rgba')

  // 每字段的列偏移（ascii）或字节偏移（binary）
  const col = []
  const byteOff = []
  let c = 0
  let b = 0
  for (let k = 0; k < meta.fields.length; k++) {
    const cnt = meta.count[k] || 1
    col.push(c)
    byteOff.push(b)
    c += cnt
    b += cnt * (meta.size[k] || 4)
  }
  const pointStep = b

  const rgbIsFloat = iRGB >= 0 && meta.type[iRGB] === 'F'
  const strideFor = (total) => (maxPoints > 0 && total > maxPoints ? Math.ceil(total / maxPoints) : 1)

  let positions
  let intensities = null
  let colors = null
  let count
  let originalCount
  let stride

  if (dataMode === 'ascii') {
    const text = TEXT.decode(buf.slice(dataStart))
    const rows = text.split(/\r?\n/)
    originalCount = meta.points || rows.length
    stride = strideFor(originalCount)
    const cap = Math.ceil(originalCount / stride) + 16
    const pos = new Float32Array(cap * 3)
    const inten = iInt >= 0 ? new Float32Array(cap) : null
    const colr = iRGB >= 0 ? new Float32Array(cap * 3) : null
    let w = 0
    let valid = 0
    for (const row of rows) {
      if (!row) continue
      const tok = row.trim().split(/\s+/)
      if (tok.length < c || isNaN(+tok[col[ix]])) continue
      if (valid++ % stride) continue
      const x = +tok[col[ix]]
      const y = +tok[col[iy]]
      const z = +tok[col[iz]]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      pos[w * 3] = x
      pos[w * 3 + 1] = y
      pos[w * 3 + 2] = z
      if (inten) inten[w] = +tok[col[iInt]] || 0
      if (colr) {
        let r
        let g
        let bl
        if (rgbIsFloat) {
          const bits = new Uint32Array(new Float32Array([+tok[col[iRGB]]]).buffer)[0]
          r = (bits >>> 16) & 255
          g = (bits >>> 8) & 255
          bl = bits & 255
        } else {
          const v = +tok[col[iRGB]] || 0
          r = (v >>> 16) & 255
          g = (v >>> 8) & 255
          bl = v & 255
        }
        colr[w * 3] = r / 255
        colr[w * 3 + 1] = g / 255
        colr[w * 3 + 2] = bl / 255
      }
      w++
    }
    if (!w) throw new Error('PCD 中没有可解析的点')
    positions = new Float32Array(pos.buffer, 0, w * 3)
    intensities = inten && new Float32Array(inten.buffer, 0, w)
    colors = colr && new Float32Array(colr.buffer, 0, w * 3)
    count = w
  } else {
    // binary
    const dv = new DataView(buf)
    originalCount = meta.points || Math.floor((buf.byteLength - dataStart) / pointStep)
    stride = strideFor(originalCount)
    const cap = Math.ceil(originalCount / stride)
    const pos = new Float32Array(cap * 3)
    const inten = iInt >= 0 ? new Float32Array(cap) : null
    const colr = iRGB >= 0 ? new Float32Array(cap * 3) : null
    let w = 0
    for (let k = 0; k < originalCount; k += stride) {
      const base = dataStart + k * pointStep
      const x = readBin(dv, base + byteOff[ix], meta.size[ix], meta.type[ix])
      const y = readBin(dv, base + byteOff[iy], meta.size[iy], meta.type[iy])
      const z = readBin(dv, base + byteOff[iz], meta.size[iz], meta.type[iz])
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      pos[w * 3] = x
      pos[w * 3 + 1] = y
      pos[w * 3 + 2] = z
      if (inten) inten[w] = readBin(dv, base + byteOff[iInt], meta.size[iInt], meta.type[iInt])
      if (colr) {
        const bits = dv.getUint32(base + byteOff[iRGB], true) // float 比特即打包颜色
        colr[w * 3] = ((bits >>> 16) & 255) / 255
        colr[w * 3 + 1] = ((bits >>> 8) & 255) / 255
        colr[w * 3 + 2] = (bits & 255) / 255
      }
      w++
    }
    if (!w) throw new Error('PCD 中没有有效点（可能全部为 NaN）')
    positions = new Float32Array(pos.buffer, 0, w * 3)
    intensities = inten && new Float32Array(inten.buffer, 0, w)
    colors = colr && new Float32Array(colr.buffer, 0, w * 3)
    count = w
  }

  return {
    name,
    positions,
    intensities: intensities || null,
    colors: colors || null,
    count,
    meta: { originalCount, stride },
  }
}
