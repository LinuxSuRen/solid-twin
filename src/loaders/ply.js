// PLY 解析：支持 ascii / binary_little_endian / binary_big_endian。
// 读取 vertex 元素的 x y z + (red green blue | r g b) + intensity，忽略其余元素。
// 大文件在解析期按步长抽稀（maxPoints 预算），并跳过 NaN/Inf 点。

const TEXT = new TextDecoder()

const TYPE_SIZE = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
}

function readVal(dv, off, type, le) {
  switch (type) {
    case 'char': case 'int8': return dv.getInt8(off)
    case 'uchar': case 'uint8': return dv.getUint8(off)
    case 'short': case 'int16': return dv.getInt16(off, le)
    case 'ushort': case 'uint16': return dv.getUint16(off, le)
    case 'int': case 'int32': return dv.getInt32(off, le)
    case 'uint': case 'uint32': return dv.getUint32(off, le)
    case 'float': case 'float32': return dv.getFloat32(off, le)
    case 'double': case 'float64': return dv.getFloat64(off, le)
    default: return NaN
  }
}

export function parsePLY(buf, name, maxPoints = 0) {
  const headText = TEXT.decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1 << 16)))
  if (!headText.startsWith('ply')) throw new Error('不是有效的 PLY 文件')
  const endTag = headText.indexOf('end_header')
  if (endTag < 0) throw new Error('PLY 头部缺少 end_header')

  let dataStart = endTag + 'end_header'.length
  while (dataStart < headText.length && (headText[dataStart] === '\r' || headText[dataStart] === '\n')) {
    if (headText[dataStart] === '\n') {
      dataStart++
      break
    }
    dataStart++
  }

  let format = ''
  const elements = []
  for (const line of headText.slice(0, endTag).split(/\r?\n/)) {
    const p = line.trim().split(/\s+/)
    if (p[0] === 'format') format = p[1]
    else if (p[0] === 'element') elements.push({ name: p[1], count: Number(p[2]) || 0, props: [] })
    else if (p[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1]
      if (p[1] === 'list') el.props.push({ list: true, countType: p[2], itemType: p[3], name: p[4] })
      else el.props.push({ type: p[1], name: p[2] })
    }
  }
  const vIdx = elements.findIndex((e) => e.name === 'vertex')
  if (vIdx < 0) throw new Error('PLY 中没有 vertex 元素')
  const vertex = elements[vIdx]

  const propIndex = {}
  vertex.props.forEach((pr, i) => {
    if (!pr.list) propIndex[pr.name] = i
  })
  const keyOf = (...names) => {
    for (const n of names) if (propIndex[n] !== undefined) return propIndex[n]
    return -1
  }
  const ix = keyOf('x')
  const iy = keyOf('y')
  const iz = keyOf('z')
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PLY vertex 缺少 x/y/z 属性')
  const iInt = keyOf('intensity', 'scalar_Intensity')
  const iR = keyOf('red', 'r', 'diffuse_red')
  const iG = keyOf('green', 'g', 'diffuse_green')
  const iB = keyOf('blue', 'b', 'diffuse_blue')
  const hasColor = iR >= 0 && iG >= 0 && iB >= 0

  const totalCount = vertex.count
  const stride = maxPoints > 0 && totalCount > maxPoints ? Math.ceil(totalCount / maxPoints) : 1
  const cap = Math.ceil(totalCount / stride)
  const positions = new Float32Array(cap * 3)
  const intensities = iInt >= 0 ? new Float32Array(cap) : null
  const colors = hasColor ? new Float32Array(cap * 3) : null
  const skipBefore = elements.slice(0, vIdx)
  let w = 0

  if (format === 'ascii') {
    const text = TEXT.decode(buf.slice(dataStart))
    const rows = text.split(/\r?\n/).filter((r) => r.length)
    let row = 0
    for (const el of skipBefore) row += el.count // 逐行跳过（假定每个元素占一行）
    for (let p = 0; p < totalCount; p += stride) {
      const tok = (rows[row] || '').trim().split(/\s+/)
      row += stride
      const x = +tok[ix]
      const y = +tok[iy]
      const z = +tok[iz]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      positions[w * 3] = x
      positions[w * 3 + 1] = y
      positions[w * 3 + 2] = z
      if (intensities) intensities[w] = +tok[iInt] || 0
      if (colors) {
        colors[w * 3] = clampColor(+tok[iR])
        colors[w * 3 + 1] = clampColor(+tok[iG])
        colors[w * 3 + 2] = clampColor(+tok[iB])
      }
      w++
    }
  } else if (format.startsWith('binary')) {
    const le = format === 'binary_little_endian'
    const dv = new DataView(buf)
    let off = dataStart
    for (const el of skipBefore) {
      for (const pr of el.props) {
        if (pr.list) throw new Error('暂不支持 vertex 之前的 list 属性元素（' + el.name + '）')
      }
      const size = el.props.reduce((s, pr) => s + (TYPE_SIZE[pr.type] || 4), 0)
      off += size * el.count
    }
    const offs = []
    let b = 0
    for (const pr of vertex.props) {
      offs.push(b)
      b += TYPE_SIZE[pr.type] || 4
    }
    const step = b
    const rgbIsFloat = hasColor && /float|double/.test(vertex.props[iR].type)
    for (let p = 0; p < totalCount; p += stride) {
      const base = off + p * step
      const x = readVal(dv, base + offs[ix], vertex.props[ix].type, le)
      const y = readVal(dv, base + offs[iy], vertex.props[iy].type, le)
      const z = readVal(dv, base + offs[iz], vertex.props[iz].type, le)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      positions[w * 3] = x
      positions[w * 3 + 1] = y
      positions[w * 3 + 2] = z
      if (intensities) intensities[w] = readVal(dv, base + offs[iInt], vertex.props[iInt].type, le)
      if (colors) {
        colors[w * 3] = clampColor(readVal(dv, base + offs[iR], vertex.props[iR].type, le), rgbIsFloat)
        colors[w * 3 + 1] = clampColor(readVal(dv, base + offs[iG], vertex.props[iG].type, le), rgbIsFloat)
        colors[w * 3 + 2] = clampColor(readVal(dv, base + offs[iB], vertex.props[iB].type, le), rgbIsFloat)
      }
      w++
    }
  } else {
    throw new Error('未知的 PLY 格式: ' + format)
  }
  if (!w) throw new Error('PLY 中没有有效点')

  return {
    name,
    positions: new Float32Array(positions.buffer, 0, w * 3),
    intensities: intensities && new Float32Array(intensities.buffer, 0, w),
    colors: colors && new Float32Array(colors.buffer, 0, w * 3),
    count: w,
    meta: { originalCount: totalCount, stride },
  }
}

function clampColor(v, isFloat = false) {
  if (isFloat) return v < 0 ? 0 : v > 1 ? 1 : v
  return (v < 0 ? 0 : v > 255 ? 255 : v) / 255
}
