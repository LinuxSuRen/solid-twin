// ─────────────────────────────────────────────────────────────
// 点云朝向检测与重定向（归一化到查看器的 Y-up 约定）
//
// 原理：户外/站区扫描中地面回波占主导 → 点云协方差的最小特征向量
//       ≈ 地面法向（≈ 重力方向）。把它旋转到 +Y 即可让模型“站直”，
//       同时顺带校正 SLAM 漂移带来的倾斜。
// 可靠性门槛：λ0/λ1 < PLANE_RATIO 才认为是平面主导（立面/隧道扫描
//       会不满足，退化为不旋转，由用户手动指定坐标朝向）。
// 原始坐标可通过 transform 完整恢复（导出用）。
// ─────────────────────────────────────────────────────────────

const PLANE_RATIO = 0.1

/** 对称 3×3 矩阵 Jacobi 特征分解（vals 升序对应 vecs 列向量） */
function jacobi3(cov) {
  const a = cov.map((r) => r.slice())
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (let iter = 0; iter < 100; iter++) {
    let p = 0
    let q = 1
    let max = 0
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        if (Math.abs(a[i][j]) > max) {
          max = Math.abs(a[i][j])
          p = i
          q = j
        }
    if (max < 1e-12) break
    const app = a[p][p]
    const aqq = a[q][q]
    const apq = a[p][q]
    const th = (aqq - app) / (2 * apq)
    const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1))
    const c = 1 / Math.sqrt(t * t + 1)
    const s = t * c
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p]
      const akq = a[k][q]
      a[k][p] = c * akp - s * akq
      a[k][q] = s * akp + c * akq
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k]
      const aqk = a[q][k]
      a[p][k] = c * apk - s * aqk
      a[q][k] = s * apk + c * aqk
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p]
      const vkq = v[k][q]
      v[k][p] = c * vkp - s * vkq
      v[k][q] = s * vkp + c * vkq
    }
  }
  return { vals: [a[0][0], a[1][1], a[2][2]], vecs: v }
}

/**
 * 检测地面法向（PCA，子采样）。
 * 返回 { normal, eigenvalues, centroid } 或 null（点太少）。
 */
export function detectGroundNormal(positions, count, sampleTarget = 50000) {
  if (count < 1000) return null
  const stride = Math.max(1, Math.floor(count / sampleTarget))
  const n = Math.floor(count / stride)
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    const o = i * stride * 3
    cx += positions[o]
    cy += positions[o + 1]
    cz += positions[o + 2]
  }
  cx /= n
  cy /= n
  cz /= n
  let xx = 0
  let xy = 0
  let xz = 0
  let yy = 0
  let yz = 0
  let zz = 0
  for (let i = 0; i < n; i++) {
    const o = i * stride * 3
    const x = positions[o] - cx
    const y = positions[o + 1] - cy
    const z = positions[o + 2] - cz
    xx += x * x
    xy += x * y
    xz += x * z
    yy += y * y
    yz += y * z
    zz += z * z
  }
  const { vals, vecs } = jacobi3([
    [xx / n, xy / n, xz / n],
    [xy / n, yy / n, yz / n],
    [xz / n, yz / n, zz / n],
  ])
  const order = [0, 1, 2].sort((a, b) => vals[a] - vals[b])
  return {
    normal: [vecs[0][order[0]], vecs[1][order[0]], vecs[2][order[0]]],
    eigenvalues: order.map((i) => vals[i]),
    centroid: [cx, cy, cz],
  }
}

/** 构造行向量基 R = [u; n; v]（满足 R·n = (0,1,0)），n 为单位向量 */
function rotationToY(nRaw) {
  const len = Math.hypot(nRaw[0], nRaw[1], nRaw[2]) || 1
  const n = [nRaw[0] / len, nRaw[1] / len, nRaw[2] / len]
  const ax = Math.abs(n[0])
  const ay = Math.abs(n[1])
  const az = Math.abs(n[2])
  const hint = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  let u = [hint[1] * n[2] - hint[2] * n[1], hint[2] * n[0] - hint[0] * n[2], hint[0] * n[1] - hint[1] * n[0]]
  const ul = Math.hypot(u[0], u[1], u[2]) || 1
  u = [u[0] / ul, u[1] / ul, u[2] / ul]
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  return [u, n, v]
}

/** 符号校正：地面（众数高度）应低于中位高度（设备在地面上方） */
function groundBelowMedian(positions, count, R, c) {
  const stride = Math.max(1, Math.floor(count / 20000))
  const n = Math.floor(count / stride)
  const ys = new Float64Array(n)
  let mn = Infinity
  let mx = -Infinity
  for (let i = 0; i < n; i++) {
    const o = i * stride * 3
    const y =
      R[1][0] * (positions[o] - c[0]) + R[1][1] * (positions[o + 1] - c[1]) + R[1][2] * (positions[o + 2] - c[2])
    ys[i] = y
    if (y < mn) mn = y
    if (y > mx) mx = y
  }
  const B = 100
  const h = new Float64Array(B)
  for (let i = 0; i < n; i++) {
    let b = Math.floor(((ys[i] - mn) / (mx - mn)) * B)
    if (b >= B) b = B - 1
    h[b]++
  }
  let mb = 0
  for (let b = 1; b < B; b++) if (h[b] > h[mb]) mb = b
  const groundY = mn + ((mb + 0.5) / B) * (mx - mn)
  const sorted = Array.from(ys).sort((a, b) => a - b)
  const medianY = sorted[Math.floor(n / 2)]
  return medianY > groundY
}

function isIdentity(R) {
  return R[0][0] === 1 && R[1][1] === 1 && R[2][2] === 1 && R[0][1] === 0
}

/**
 * 把图层重定向到 Y-up（基于 rawPositions，可重复调用、可手动覆盖）。
 * mode: 'auto'（PCA 自动）| 'x' | 'y' | 'z'
 * 变换记录在 d.transform，可用 restorePoint() 恢复原始坐标。
 */
export function applyOrientation(d, mode) {
  const raw = d.rawPositions || (d.rawPositions = d.positions.slice())
  const count = d.count
  let R = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  let c = [0, 0, 0]

  if (mode === 'auto') {
    const det = detectGroundNormal(raw, count)
    if (det && det.eigenvalues[0] / Math.max(det.eigenvalues[1], 1e-12) < PLANE_RATIO) {
      R = rotationToY(det.normal)
      c = det.centroid
      if (!groundBelowMedian(raw, count, R, c)) {
        R = rotationToY([-det.normal[0], -det.normal[1], -det.normal[2]])
      }
    }
  } else if (mode === 'x' || mode === 'z') {
    R = rotationToY(mode === 'x' ? [1, 0, 0] : [0, 0, 1])
    c = centroidOf(raw, count)
  }

  // 旋转（绕质心）
  const out = d.positions
  for (let i = 0; i < count; i++) {
    const x = raw[i * 3] - c[0]
    const y = raw[i * 3 + 1] - c[1]
    const z = raw[i * 3 + 2] - c[2]
    out[i * 3] = R[0][0] * x + R[0][1] * y + R[0][2] * z
    out[i * 3 + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z
    out[i * 3 + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z
  }

  // 重居中：XZ 取包围盒中心，min-Y 落到地面 0
  let minx = Infinity
  let miny = Infinity
  let minz = Infinity
  let maxx = -Infinity
  let maxy = -Infinity
  let maxz = -Infinity
  for (let i = 0; i < count; i++) {
    const x = out[i * 3]
    const y = out[i * 3 + 1]
    const z = out[i * 3 + 2]
    if (x < minx) minx = x
    if (x > maxx) maxx = x
    if (y < miny) miny = y
    if (y > maxy) maxy = y
    if (z < minz) minz = z
    if (z > maxz) maxz = z
  }
  const ox = (minx + maxx) / 2
  const oy = miny
  const oz = (minz + maxz) / 2
  for (let i = 0; i < count; i++) {
    out[i * 3] -= ox
    out[i * 3 + 1] -= oy
    out[i * 3 + 2] -= oz
  }

  d.transform = { rot: R, center: c, shift: [ox, oy, oz] }
  // 兼容字段：仅当旋转为单位阵时 offset 才有直接语义（旧导出路径/测试依赖）
  d.offset = isIdentity(R) ? [ox + c[0], oy + c[1], oz + c[2]] : null
  d.bounds = { min: [minx - ox, 0, minz - oz], max: [maxx - ox, maxy - oy, maxz - oz] }
  d.orientMode = mode
  return d
}

function centroidOf(positions, count) {
  const stride = Math.max(1, Math.floor(count / 50000))
  const n = Math.floor(count / stride)
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    const o = i * stride * 3
    cx += positions[o]
    cy += positions[o + 1]
    cz += positions[o + 2]
  }
  return [cx / n, cy / n, cz / n]
}

/** 把视图坐标恢复为文件原始坐标（导出用）。out 为可复用的 [x,y,z]。 */
export function restorePoint(d, i, out = [0, 0, 0]) {
  const t = d.transform
  if (!t) {
    const off = d.offset || [0, 0, 0]
    out[0] = d.positions[i * 3] + off[0]
    out[1] = d.positions[i * 3 + 1] + off[1]
    out[2] = d.positions[i * 3 + 2] + off[2]
    return out
  }
  const px = d.positions[i * 3] + t.shift[0]
  const py = d.positions[i * 3 + 1] + t.shift[1]
  const pz = d.positions[i * 3 + 2] + t.shift[2]
  // 原始 = Rᵀ·(stored + shift) + center，其中 (Rᵀq)ᵢ = R 的第 i 列 · q
  out[0] = t.rot[0][0] * px + t.rot[1][0] * py + t.rot[2][0] * pz + t.center[0]
  out[1] = t.rot[0][1] * px + t.rot[1][1] * py + t.rot[2][1] * pz + t.center[1]
  out[2] = t.rot[0][2] * px + t.rot[1][2] * py + t.rot[2][2] * pz + t.center[2]
  return out
}

/** 视图坐标 → 文件原始坐标（标注锚点时换算存储位置） */
export function viewToOriginal(d, vx, vy, vz, out = [0, 0, 0]) {
  return restorePoint({ ...d, positions: new Float32Array([vx, vy, vz]) }, 0, out)
}

/** 文件原始坐标 → 视图坐标（锚点显示时应用与点云相同的变换） */
export function originalToView(d, ox, oy, oz, out = [0, 0, 0]) {
  const t = d.transform
  if (!t) {
    const off = d.offset || [0, 0, 0]
    out[0] = ox - off[0]
    out[1] = oy - off[1]
    out[2] = oz - off[2]
    return out
  }
  const x = ox - t.center[0]
  const y = oy - t.center[1]
  const z = oz - t.center[2]
  out[0] = t.rot[0][0] * x + t.rot[0][1] * y + t.rot[0][2] * z - t.shift[0]
  out[1] = t.rot[1][0] * x + t.rot[1][1] * y + t.rot[1][2] * z - t.shift[1]
  out[2] = t.rot[2][0] * x + t.rot[2][1] * y + t.rot[2][2] * z - t.shift[2]
  return out
}
