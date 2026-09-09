// 离线回归测试：验证「bag → bag2cloud.py → PCD/PLY → 浏览器解析器」全链路。
// 前置：
//   python scripts/make_test_bag.py
//   python scripts/bag2cloud.py test_data/synthetic.bag -t /livox/lidar -o test_data/custom_msg.ply
//   python scripts/bag2cloud.py test_data/synthetic.bag -t /points -o test_data/pc2.pcd
//   node scripts/gen_sample.mjs
// 运行：node scripts/test_loaders.mjs

import { readFileSync } from 'node:fs'
import { parseBuffer } from '../src/loaders/index.js'
import { applyOrientation, restorePoint } from '../src/orientation.js'

let failed = 0
// Node Buffer → ArrayBuffer（浏览器端由 file.arrayBuffer() 提供）
function ab(path) {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
function approx(name, got, want, tol = 1e-3) {
  const ok = Math.abs(got - want) <= tol
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${got} ≈ ${want}`)
}
function assert(name, cond) {
  if (!cond) failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
}

// ── 1. livox CustomMsg → PLY 往返 ──────────────────
// 原始坐标: x=(j%50)*10mm ∈[0,0.49], y=1.2m, z=(j//50)*5mm ∈[0,0.045], refl=(j%256)/255
console.log('[1] livox CustomMsg → PLY')
{
  const d = parseBuffer(ab('test_data/custom_msg.ply'), 'custom_msg.ply')
  assert('点数 1000（500×2 帧）', d.count === 1000)
  // 恢复原始坐标（loader 重居中: offset = [中心x, minY, 中心z]）
  const x0 = d.positions[0] + d.offset[0]
  const y0 = d.positions[1] + d.offset[1]
  const xLast = d.positions[(d.count - 1) * 3] + d.offset[0]
  approx('首点 x ≈ 0 m', x0, 0)
  approx('首点 y ≈ 1.2 m', y0, 1.2)
  approx('末点 x ≈ 0.49 m', xLast, 0.49)
  assert('强度存在', !!d.intensities)
  approx('首点强度 ≈ 0', d.intensities[0], 0)
  approx('强度[255] ≈ 1.0', d.intensities[255], 1.0, 0.01)
}

// ── 2. PointCloud2 → PCD 往返 ─────────────────────
console.log('[2] PointCloud2 → PCD')
{
  const d = parseBuffer(ab('test_data/pc2.pcd'), 'pc2.pcd')
  assert('点数 600（300×2 帧）', d.count === 600)
  const z0 = d.positions[2] + d.offset[2]
  const xLast = d.positions[(d.count - 1) * 3] + d.offset[0]
  approx('首点 z ≈ 1.5 m', z0, 1.5)
  approx('末点 x ≈ 2.9 m', xLast, 2.9)
  approx('强度[299] ≈ 43/255', d.intensities[299], 43 / 255, 0.01)
}

// ── 3. 仿真样本 PCD ───────────────────────────────
console.log('[3] Mid-360 仿真样本 PCD')
{
  const d = parseBuffer(ab('data/mid360_room_sample.pcd'), 'mid360_room_sample.pcd')
  assert('点数 > 100k', d.count > 100000)
  assert('强度存在', !!d.intensities)
  const span = d.bounds.max[0] - d.bounds.min[0]
  approx('房间跨度 ≈ 16 m（含噪声）', span, 16, 0.5)
  const st = new Set()
  // 通过重新推导验证重居中后 y 从 0 起
  approx('最低点 y ≈ 0', d.bounds.min[1], 0, 0.05)
}

// ── 4. 导出再解析（PCD 读写往返） ─────────────────
console.log('[4] PCD → 导出 → 再解析')
{
  // 模拟 main.js 的导出逻辑（binary PCD x y z intensity）
  const src = parseBuffer(ab('test_data/pc2.pcd'), 'pc2.pcd')
  const n = src.count
  const header =
    `# .PCD v0.7\nVERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\n` +
    `COUNT 1 1 1 1\nWIDTH ${n}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${n}\nDATA binary\n`
  const body = new ArrayBuffer(n * 16)
  const dv = new DataView(body)
  for (let i = 0; i < n; i++) {
    dv.setFloat32(i * 16, src.positions[i * 3] + src.offset[0], true)
    dv.setFloat32(i * 16 + 4, src.positions[i * 3 + 1] + src.offset[1], true)
    dv.setFloat32(i * 16 + 8, src.positions[i * 3 + 2] + src.offset[2], true)
    dv.setFloat32(i * 16 + 12, src.intensities[i], true)
  }
  const d = parseBuffer(Buffer.concat([Buffer.from(header), Buffer.from(body)]), 'roundtrip.pcd')
  assert('往返点数一致', d.count === n)
  approx('往返首点 z ≈ 1.5', d.positions[2] + d.offset[2], 1.5)
}

// ── 5. PCL 标准注释头 + CRLF + NaN 点 ────────────
// 回归用例：头部注释含 "Cloud Data file format"，曾导致 DATA 行误定位
console.log('[5] PCL 标准注释头 / CRLF / NaN 过滤')
{
  const n = 10
  const header =
    '# .PCD v0.7 - Point Cloud Data file format\r\n' +
    'VERSION 0.7\r\nFIELDS x y z intensity\r\nSIZE 4 4 4 4\r\nTYPE F F F F\r\n' +
    'COUNT 1 1 1 1\r\nWIDTH 10\r\nHEIGHT 1\r\nVIEWPOINT 0 0 0 1 0 0 0\r\n' +
    'POINTS 10\r\nDATA binary\r\n'
  const body = new ArrayBuffer(n * 16)
  const dv = new DataView(body)
  for (let i = 0; i < n; i++) {
    dv.setFloat32(i * 16, i * 1.0, true)
    dv.setFloat32(i * 16 + 4, i * 2.0, true)
    dv.setFloat32(i * 16 + 8, 3.0, true)
    dv.setFloat32(i * 16 + 12, i * 0.5, true)
  }
  // 第 5 个点写成 NaN，应被过滤
  dv.setFloat32(4 * 16, NaN, true)
  const d = parseBuffer(Buffer.concat([Buffer.from(header), Buffer.from(body)]), 'standard_header.pcd')
  assert('NaN 点被过滤后剩 9 点', d.count === 9)
  approx('首点 x ≈ 0', d.positions[0] + d.offset[0], 0)
  approx('末点 z ≈ 3', d.positions[8 * 3 + 2] + d.offset[2], 3)
  approx('末点强度 ≈ 4.5', d.intensities[8], 4.5)
}

// ── 6. 朝向自动检测（倾斜 Z-up → Y-up + 坐标往返） ──
console.log('[6] 朝向自动检测（倾斜 10° 的 Z-up 场景）')
{
  // 100×100m 地面（x-y 平面）绕 x 轴倾斜 10°，加 2000 个 5m 高柱点
  const ground = 20000
  const pillars = 2000
  const n = ground + pillars
  const raw = new Float32Array(n * 3)
  const th = (10 * Math.PI) / 180
  let k = 0
  for (let i = 0; i < ground; i++) {
    const x = Math.random() * 100 - 50
    const y = Math.random() * 100 - 50
    const z = Math.random() * 0.05
    raw[k++] = x
    raw[k++] = y * Math.cos(th) - z * Math.sin(th)
    raw[k++] = y * Math.sin(th) + z * Math.cos(th)
  }
  for (let i = 0; i < pillars; i++) {
    const x = Math.random() * 20 - 10
    const y = Math.random() * 20 - 10
    const h = Math.random() * 5
    raw[k++] = x
    raw[k++] = y * Math.cos(th) - h * Math.sin(th)
    raw[k++] = y * Math.sin(th) + h * Math.cos(th)
  }
  const d = { name: 'tilted', positions: raw.slice(), count: n, intensities: null, colors: null }
  d.rawPositions = raw
  applyOrientation(d, 'auto')
  assert('PCA 触发了旋转', d.offset === null && d.transform)
  assert('竖直跨度 ≈ 5m（柱高），而非 ~100m', d.bounds.max[1] > 3 && d.bounds.max[1] < 8)
  assert('水平跨度 ~100m', d.bounds.max[0] - d.bounds.min[0] > 80)
  approx('地面贴合 y=0', d.bounds.min[1], 0, 0.1)
  // 坐标往返：视图坐标 → 原始坐标（导出路径）
  const out = [0, 0, 0]
  let maxErr = 0
  for (let i = 0; i < n; i += 997) {
    restorePoint(d, i, out)
    maxErr = Math.max(
      maxErr,
      Math.abs(out[0] - raw[i * 3]),
      Math.abs(out[1] - raw[i * 3 + 1]),
      Math.abs(out[2] - raw[i * 3 + 2]),
    )
  }
  approx('原始坐标恢复误差 < 1mm', maxErr, 0, 1e-3)
  // 手动覆盖回 Y 朝上（恒等旋转）→ 竖直跨度恢复 ~100m（原数据 y 轴跨度）
  applyOrientation(d, 'y')
  assert('手动 Y-up 后竖直跨度 ~100m', d.bounds.max[1] - d.bounds.min[1] > 80)
}

console.log(failed ? `\n✗ ${failed} 项断言失败` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
