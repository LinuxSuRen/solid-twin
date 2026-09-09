// 生成 data/mid360_room_sample.pcd：
// 用与浏览器端相同的 Mid-360 非重复扫描仿真器导出样本点云，
// 供离线测试查看器的 PCD 载入链路（无需任何设备）。
//
//   node scripts/gen_sample.mjs

import { writeFileSync, mkdirSync } from 'node:fs'
import { generateMid360Cloud } from '../src/sim/mid360.js'

const cloud = generateMid360Cloud({ duration: 4.5, rate: 15000 })
const { positions, intensities, stations, count } = cloud

// PCD binary: FIELDS x y z intensity station / SIZE 4 4 4 4 1 / TYPE F F F F U
// 头部刻意使用 PCL 标准注释（含 "Cloud Data file" 字样）作为解析器回归用例
const header =
  `# .PCD v0.7 - Point Cloud Data file format\n` +
  `VERSION 0.7\nFIELDS x y z intensity station\nSIZE 4 4 4 4 1\nTYPE F F F F U\n` +
  `COUNT 1 1 1 1 1\nWIDTH ${count}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\n` +
  `POINTS ${count}\nDATA binary\n`

const step = 17
const body = new ArrayBuffer(count * step)
const dv = new DataView(body)
for (let i = 0; i < count; i++) {
  const o = i * step
  dv.setFloat32(o, positions[i * 3], true)
  dv.setFloat32(o + 4, positions[i * 3 + 1], true)
  dv.setFloat32(o + 8, positions[i * 3 + 2], true)
  dv.setFloat32(o + 12, intensities[i], true)
  dv.setUint8(o + 16, stations[i])
}

mkdirSync(new URL('../data/', import.meta.url), { recursive: true })
const out = new URL('../data/mid360_room_sample.pcd', import.meta.url)
writeFileSync(out, Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(body)]))
console.log(`✓ ${count} 点（${cloud.meta.stations} 测站 × ${cloud.meta.pointsPerStation} 点）→ ${out.pathname}`)
