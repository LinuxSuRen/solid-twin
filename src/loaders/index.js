// 格式嗅探 + 调度 + 统一后处理（朝向归一化 + 重居中）。
// 点数预算（MAX_POINTS）在解析期生效——各解析器按步长抽稀，
// 千万点级文件不会先物化数百 MB 中间数组。
// orient: true 时自动检测地面法向（PCA）并旋转到 Y-up，原始坐标可经
// d.transform 恢复（见 src/orientation.js）。

import { parsePCD } from './pcd.js'
import { parsePLY } from './ply.js'
import { parseLAS } from './las.js'
import { parseKittiBin } from './kitti.js'
import { parseXYZ } from './xyz.js'
import { applyOrientation } from '../orientation.js'

export const MAX_POINTS = 8_000_000

export function parseBuffer(input, name, opts = {}) {
  const maxPoints = opts.maxPoints ?? MAX_POINTS
  const orient = opts.orient ?? false
  // 归一化：Node Buffer / SharedArrayBuffer 兼容（浏览器端通常已是 ArrayBuffer）
  const buf = input?.buffer && input.byteLength !== undefined && !(input instanceof ArrayBuffer)
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
    : input
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 512)))
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.split('.').pop() : ''

  let data
  if (head.startsWith('ply')) data = parsePLY(buf, name, maxPoints)
  else if (/^#\s*\.?PCD/i.test(head.trimStart()) || ext === 'pcd') data = parsePCD(buf, name, maxPoints)
  else if (head.startsWith('LASF')) data = parseLAS(buf, name, maxPoints)
  else if (ext === 'bin') data = parseKittiBin(buf, name, maxPoints)
  else data = parseXYZ(buf, name, maxPoints)

  // 后处理：保留原始坐标副本 → 朝向归一化 + 重居中
  data.rawPositions = data.positions.slice()
  data.decimated = (data.meta?.stride || 1) > 1
  applyOrientation(data, orient ? 'auto' : 'y')
  return data
}

export async function loadFiles(files, opts = {}) {
  const results = []
  for (const file of files) {
    const buf = await file.arrayBuffer()
    results.push(parseBuffer(buf, file.name, opts))
  }
  return results
}
