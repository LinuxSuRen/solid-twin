// 应用入口：UI 交互、模拟扫描生成、文件载入、PCD 导出

import { TwinViewer } from './viewer.js'
import { generateMid360Cloud } from './sim/mid360.js'
import { loadFiles } from './loaders/index.js'
import { applyOrientation, restorePoint, viewToOriginal } from './orientation.js'
import { LEVEL_COLORS } from './devices.js'
import { STATION_COLORS } from './colormaps.js'

const $ = (id) => document.getElementById(id)
const fmt = (n) => n.toLocaleString('zh-CN')

const viewer = new TwinViewer($('scene-container'), {
  onStats: (s) => {
    $('hud').textContent = `FPS  ${s.fps}\n点   ${fmt(s.drawn)} / ${fmt(s.total)}`
  },
  onReplay: (p, playing) => {
    $('replay-bar').style.width = `${(p * 100).toFixed(1)}%`
    $('replay-text').textContent = playing
      ? `回放中… ${(p * 100).toFixed(0)}%（非重复扫描按时间顺序累积）`
      : p >= 1
        ? '回放完成 · 可重新播放'
        : '已暂停'
    $('btn-play').textContent = playing ? '⏸ 暂停' : '▶ 播放'
  },
})

let simLayerIds = []
const deviceLayer = viewer.deviceLayer

// 取景中心对齐到控制面板右侧的可见区域（避免点云视觉上偏左）
function updateViewportInset() {
  const p = $('panel')
  viewer.setViewportInset(p ? p.offsetLeft + p.offsetWidth : 0)
}
updateViewportInset()
window.addEventListener('resize', updateViewportInset)

// ── 状态提示 ───────────────────────────────
let statusTimer = null
function status(msg, { error = false, sticky = false } = {}) {
  const el = $('status')
  el.textContent = msg
  el.classList.toggle('error', error)
  el.classList.add('show')
  clearTimeout(statusTimer)
  if (!sticky) statusTimer = setTimeout(() => el.classList.remove('show'), 3200)
}

// ── 模拟扫描 ───────────────────────────────
function runSimulation({ autoplay = true } = {}) {
  status('正在生成 Mid-360 非重复扫描模拟…', { sticky: true })
  setTimeout(() => {
    for (const id of simLayerIds) viewer.removeLayer(id)
    simLayerIds = []
    const t0 = performance.now()
    const cloud = generateMid360Cloud()
    const ms = Math.round(performance.now() - t0)
    const id = viewer.addLayer({ ...cloud, name: '模拟扫描 · 3 测站' })
    simLayerIds.push(id)
    renderLayerList()
    viewer.fitView()
    if (!deviceLayer.devices.size) seedSimDevices()
    status(`模拟完成：${fmt(cloud.count)} 点 / ${ms} ms（${cloud.meta.pointsPerStation} 点×${cloud.meta.stations} 站）`)
    if (autoplay) {
      viewer.startReplay(Math.max(20000, Math.round(cloud.count / 3 / 8)))
      $('btn-play').textContent = '⏸ 暂停'
    }
  }, 30)
}

// ── 图层列表 ───────────────────────────────
function renderLayerList() {
  const box = $('layers')
  box.innerHTML = ''
  let li = 0
  for (const l of viewer.layers.values()) {
    const el = document.createElement('div')
    el.className = 'layer-item'
    const c = STATION_COLORS[li % STATION_COLORS.length]
    const rgb = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`
    el.innerHTML = `
      <span class="dot" style="background:${rgb}"></span>
      <input type="checkbox" checked title="显示/隐藏" />
      <span class="name" title="${l.name}">${l.name}</span>
      <span class="cnt">${fmt(l.data.count)}</span>
      <button class="danger" title="移除图层">✕</button>`
    const [chk, del] = el.querySelectorAll('input, button')
    chk.addEventListener('change', () => {
      viewer.setLayerVisible(l.id, chk.checked)
      renderLayerList()
    })
    del.addEventListener('click', () => {
      if (viewer.layers.size === 1) return status('至少保留一个图层', { error: true })
      viewer.removeLayer(l.id)
      simLayerIds = simLayerIds.filter((i) => i !== l.id)
      renderLayerList()
    })
    box.appendChild(el)
    li++
  }
}

// ── 文件载入 ───────────────────────────────
const BAG_RE = /\.(bag|db3|mcap)$/i

async function handleFiles(fileList) {
  let files = [...fileList]
  if (!files.length) return
  const bags = files.filter((f) => BAG_RE.test(f.name))
  if (bags.length) {
    const cmd = `python scripts/bag2cloud.py ${bags[0].name} -t /livox/lidar -o map.ply --every 5`
    console.info('[solid-twin] rosbag 需先离线转换：\n  ' + cmd)
    status(
      `${bags.map((f) => f.name).join('、')} 是 rosbag：浏览器不能直接读取，请先转换（命令已打印到控制台，详见 README）`,
      { error: true },
    )
    files = files.filter((f) => !BAG_RE.test(f.name))
    if (!files.length) return
  }
  status(`正在解析 ${files.length} 个文件…`, { sticky: true })
  await new Promise((r) => setTimeout(r, 30))
  try {
    const results = await loadFiles(files, { orient: true })
    for (const d of results) viewer.addLayer(d)
    renderLayerList()
    // 站点地图的自然初始视角是平面图（俯视）
    viewer.fitView()
    viewer.topView()
    const total = results.reduce((s, d) => s + d.count, 0)
    const rotated = results.some((d) => d.orientMode === 'auto' && d.transform && d.offset === null)
    status(
      `已载入 ${results.length} 个文件，共 ${fmt(total)} 点` +
        (rotated ? '（已按 PCA 自动校正朝向）' : '') +
        (results.some((d) => d.decimated) ? '（超大文件已自动抽稀）' : ''),
    )
    // 载入真实数据时清掉演示用的种子设备（用户标注的保留）
    for (const d of [...deviceLayer.devices.values()]) if (!d.file) deviceLayer.removeDevice(d.id)
    renderDeviceList()
  } catch (err) {
    console.error(err)
    status(`解析失败：${err.message}`, { error: true })
  }
}

$('btn-open').addEventListener('click', () => $('file-input').click())
$('file-input').addEventListener('change', (e) => {
  handleFiles(e.target.files)
  e.target.value = ''
})
$('btn-sim').addEventListener('click', () => runSimulation())

// 拖放
let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragDepth++
  $('drop-overlay').classList.add('active')
})
window.addEventListener('dragleave', (e) => {
  e.preventDefault()
  if (--dragDepth <= 0) {
    dragDepth = 0
    $('drop-overlay').classList.remove('active')
  }
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  $('drop-overlay').classList.remove('active')
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files)
})

// ── 显示控制 ───────────────────────────────
$('sel-color').addEventListener('change', (e) => viewer.applyColorMode(e.target.value))
$('rg-size').addEventListener('input', (e) => {
  $('val-size').textContent = (+e.target.value).toFixed(3)
  viewer.setPointSize(+e.target.value)
})
$('rg-decim').addEventListener('input', (e) => {
  const v = +e.target.value
  $('val-decim').textContent = `${Math.round(v * 100)}%`
  viewer.setDecimation(v)
})
$('chk-grid').addEventListener('change', (e) => viewer.setGrid(e.target.checked))
$('chk-axes').addEventListener('change', (e) => viewer.setAxes(e.target.checked))
$('chk-light').addEventListener('change', (e) => viewer.setLightBackground(e.target.checked))

// ── 坐标朝向（手动覆盖 PCA 自动检测） ────────
const ORIENT_LABELS = { auto: '自动检测 (PCA)', x: 'X 朝上', y: 'Y 朝上', z: 'Z 朝上' }
$('sel-orient').addEventListener('change', (e) => {
  const mode = e.target.value
  let touched = false
  for (const l of viewer.layers.values()) {
    if (!l.data.rawPositions) continue // 模拟扫描本来就是 Y-up
    applyOrientation(l.data, mode)
    viewer.refreshLayer(l.id)
    touched = true
  }
  if (touched) {
    viewer.fitView()
    viewer.topView()
    status(`已按「${ORIENT_LABELS[mode]}」重定向坐标`)
  }
  deviceLayer.syncAll() // 锚点跟随新变换
})

// ── 设备与告警 ─────────────────────────────────
const LV_CN = { info: '信息', warn: '警告', alarm: '告警' }
const TYPE_RADIUS = { 电池簇: 2, PCS: 1.5, 变压器: 2.5, 消防: 1.2, 环境: 1, 其他: 1.5 }
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const SIM_DEVICES = [
  { id: 'PCS-01', name: '储能变流器 PCS-01', type: 'PCS', position: [5.6, 2.2, -4.2], radius: 1.5, file: null },
  { id: 'BAT-A1', name: '电池簇 A1', type: '电池簇', position: [1.7, 2.2, -3.4], radius: 1.5, file: null },
  { id: 'BAT-B2', name: '电池簇 B2', type: '电池簇', position: [-4.7, 1.6, 3.9], radius: 1.5, file: null },
  { id: 'FIRE-01', name: '消防主机', type: '消防', position: [-3, 2.6, -2.5], radius: 1.2, file: null },
  { id: 'ENV-01', name: '环境监测仪', type: '环境', position: [6.2, 3.2, 4.8], radius: 1, file: null },
]

let markMode = false
let markPick = null // { view:[x,y,z] 吸附后, data: 图层数据 }
let alarmFeed = []
let demoTimer = null
let audioCtx = null

// 锚点 → 来源图层变换解析（file 匹配图层名；null = 视图坐标）
deviceLayer.setResolver((dev) => {
  if (!dev.file) return null
  for (const l of viewer.layers.values()) if (l.data.name === dev.file) return l.data
  return null
})

function seedSimDevices() {
  deviceLayer.load(SIM_DEVICES)
  renderDeviceList()
}

function flyToDevice(d) {
  viewer.flyTo(d.viewPosition)
}

// 点击拾取：先设备标记，再点云（标记模式下吸附质心开表单）
viewer.onPick = ({ device, point }) => {
  if (device) {
    flyToDevice(device)
    status(
      `${device.name}（${device.id}）` +
        (device.alarm ? ` · ${LV_CN[device.alarm.level] || ''}：${device.alarm.message}` : ' · 状态正常'),
    )
    return
  }
  if (point && markMode) {
    const snapped = snapCentroid(point.data, point.x, point.y, point.z, 0.6)
    markPick = { view: snapped, data: point.data }
    openDeviceForm()
  }
}

/** 局部质心吸附：点击点 0.6m 邻域取均值，抗单点噪声 */
function snapCentroid(d, x, y, z, r) {
  const p = d.positions
  const r2 = r * r
  let sx = 0
  let sy = 0
  let sz = 0
  let n = 0
  for (let i = 0; i < d.count; i += 2) {
    const dx = p[i * 3] - x
    const dy = p[i * 3 + 1] - y
    const dz = p[i * 3 + 2] - z
    if (dx * dx + dy * dy + dz * dz < r2) {
      sx += p[i * 3]
      sy += p[i * 3 + 1]
      sz += p[i * 3 + 2]
      n++
    }
  }
  return n > 4 ? [sx / n, sy / n, sz / n] : [x, y, z]
}

// ── 标记设备 ──
$('btn-mark').addEventListener('click', () => {
  markMode = !markMode
  document.body.classList.toggle('mark-mode', markMode)
  $('btn-mark').textContent = markMode ? '取消标记' : '标记设备'
  if (markMode) status('标记模式：点击点云上的设备位置（自动吸附邻域质心）', { sticky: true })
  else status('已退出标记模式')
})

function openDeviceForm() {
  const f = $('device-form')
  f.hidden = false
  const [x, y, z] = markPick.view
  $('df-pos').textContent = `位置（吸附后）：(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`
  $('df-id').value = `DEV-${String(deviceLayer.devices.size + 1).padStart(2, '0')}`
  $('df-name').value = ''
  $('df-type').value = '电池簇'
  $('df-radius').value = TYPE_RADIUS['电池簇']
  $('df-count').value = 1
  $('df-name').focus()
}

$('df-type').addEventListener('change', (e) => {
  $('df-radius').value = TYPE_RADIUS[e.target.value] || 1.5
})

$('df-cancel').addEventListener('click', () => {
  $('device-form').hidden = true
})

$('df-ok').addEventListener('click', () => {
  if (!markPick) return
  const id = $('df-id').value.trim()
  const name = $('df-name').value.trim() || id
  const type = $('df-type').value
  const radius = Math.max(0.3, parseFloat($('df-radius').value) || 2)
  const count = Math.max(1, Math.min(200, parseInt($('df-count').value) || 1))
  const gap = Math.max(0, parseFloat($('df-gap').value) || 3)
  const dir = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] }[$('df-dir').value]
  if (!id) return status('请填写设备 ID', { error: true })
  try {
    const orig = [0, 0, 0]
    for (let k = 0; k < count; k++) {
      const vp = [
        markPick.view[0] + dir[0] * gap * k,
        markPick.view[1] + dir[1] * gap * k,
        markPick.view[2] + dir[2] * gap * k,
      ]
      viewToOriginal(markPick.data, vp[0], vp[1], vp[2], orig)
      deviceLayer.addDevice({
        id: count > 1 ? `${id}${k + 1}` : id,
        name: count > 1 ? `${name}-${k + 1}` : name,
        type,
        radius,
        position: [...orig],
        file: markPick.data.name,
      })
    }
  } catch (err) {
    return status(err.message, { error: true })
  }
  $('device-form').hidden = true
  markMode = false
  document.body.classList.remove('mark-mode')
  $('btn-mark').textContent = '标记设备'
  renderDeviceList()
  status(`已添加 ${count} 个设备锚点${count > 1 ? '（阵列复制）' : ''}`)
})

// ── 设备列表 ──
function renderDeviceList() {
  const box = $('device-list')
  box.innerHTML = ''
  if (!deviceLayer.devices.size) {
    box.innerHTML = '<div class="hint">暂无设备 · 点「标记设备」后在点云上点击设备位置</div>'
    return
  }
  for (const d of deviceLayer.devices.values()) {
    const el = document.createElement('div')
    el.className = 'device-row' + (d.alarm ? ' ' + d.alarm.level : '')
    el.innerHTML = `
      <span class="st"></span>
      <span class="dname">${esc(d.name)}<small>${esc(d.id)} · ${esc(d.type)} · r${d.radius}m</small></span>
      <button title="定位" data-a="fly">◎</button>
      <button class="danger" title="删除" data-a="del">✕</button>`
    el.addEventListener('click', (e) => {
      const a = e.target.dataset?.a
      if (a === 'del') {
        deviceLayer.removeDevice(d.id)
        renderDeviceList()
        return
      }
      flyToDevice(d)
    })
    box.appendChild(el)
  }
}

// ── 告警 ──
function beep(level) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)()
    audioCtx.resume?.()
    if (audioCtx.state !== 'running') return
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.type = 'sine'
    o.frequency.value = level === 'alarm' ? 880 : 620
    g.gain.setValueAtTime(0.12, audioCtx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35)
    o.connect(g)
    g.connect(audioCtx.destination)
    o.start()
    o.stop(audioCtx.currentTime + 0.36)
  } catch {}
}

function pushAlarm(id, level, message, active) {
  const d = deviceLayer.devices.get(id)
  alarmFeed.unshift({ t: new Date(), id, name: d?.name || id, level, message, active })
  alarmFeed = alarmFeed.slice(0, 50)
  if (active && (level === 'warn' || level === 'alarm')) beep(level)
  renderAlarmFeed()
  renderDeviceList()
}

function renderAlarmFeed() {
  const box = $('alarm-feed')
  box.innerHTML = ''
  for (const a of alarmFeed) {
    const el = document.createElement('div')
    el.className = 'alarm-item ' + a.level
    el.innerHTML = `<span class="badge">${LV_CN[a.level] || a.level}</span>${esc(a.name)} <span class="amsg">${esc(a.message)}</span><span class="t">${a.t.toLocaleTimeString('zh-CN')}</span>`
    el.addEventListener('click', () => {
      const d = deviceLayer.devices.get(a.id)
      if (d) flyToDevice(d)
    })
    box.appendChild(el)
  }
}

function setAlarmById(id, level, message) {
  const d = deviceLayer.setAlarm(id, level, message)
  if (d) pushAlarm(id, level, message, true)
  else status(`收到未知设备告警：${id}（请先在点云上标记该设备）`, { error: true })
}

const DEMO_ALARMS = [
  ['warn', '温度偏高 45.2°C（阈值 45°C）'],
  ['alarm', '电池簇温度过高 58.7°C，请立即处置'],
  ['alarm', '烟感触发：电池舱冒烟'],
  ['info', 'SOC 18%，建议启动充电'],
  ['warn', 'PCS 模块通信超时 3s'],
  ['alarm', '绝缘阻抗异常 12kΩ'],
]

function triggerDemoAlarm() {
  const arr = [...deviceLayer.devices.values()]
  if (!arr.length) return status('请先标记设备', { error: true })
  const d = arr[Math.floor(Math.random() * arr.length)]
  const [lv, msg] = DEMO_ALARMS[Math.floor(Math.random() * DEMO_ALARMS.length)]
  setAlarmById(d.id, lv, msg)
}

$('btn-demo-alarm').addEventListener('click', triggerDemoAlarm)

$('btn-clear-alarms').addEventListener('click', () => {
  deviceLayer.clearAllAlarms()
  renderDeviceList()
  status('已清除全部告警')
})

$('chk-demo-stream').addEventListener('change', (e) => {
  clearInterval(demoTimer)
  demoTimer = null
  if (e.target.checked) {
    demoTimer = setInterval(() => {
      const arr = [...deviceLayer.devices.values()]
      if (!arr.length) return
      if (Math.random() < 0.25) {
        const d = arr[Math.floor(Math.random() * arr.length)]
        if (deviceLayer.clearAlarm(d.id)) pushAlarm(d.id, 'info', '告警恢复，状态正常', false)
      } else {
        triggerDemoAlarm()
      }
    }, 7000)
  }
})

// ── 设备导入导出 ──
$('btn-export-devices').addEventListener('click', () => {
  const payload = { version: 1, exportedAt: new Date().toISOString(), devices: deviceLayer.serialize() }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'solid-twin-devices.json'
  a.click()
  URL.revokeObjectURL(a.href)
  status(`已导出 ${payload.devices.length} 个设备（原始坐标，含来源文件名）`)
})

$('btn-import-devices').addEventListener('click', () => $('devices-input').click())
$('devices-input').addEventListener('change', async (e) => {
  const f = e.target.files[0]
  e.target.value = ''
  if (!f) return
  try {
    const j = JSON.parse(await f.text())
    deviceLayer.load(j.devices || j)
    renderDeviceList()
    status(`已导入 ${deviceLayer.devices.size} 个设备`)
  } catch (err) {
    status('导入失败：' + err.message, { error: true })
  }
})

// ── WebSocket 实时告警源 ──
let ws = null
let wsWanted = false
let wsRetry = null

function setWsDot(on) {
  $('ws-dot').classList.toggle('on', on)
}

function openWs() {
  const url = $('ws-url').value.trim()
  if (!url) return status('请输入 WebSocket 地址', { error: true })
  wsWanted = true
  $('btn-ws').textContent = '断开'
  status('正在连接 ' + url)
  try {
    ws = new WebSocket(url)
  } catch (err) {
    setWsDot(false)
    return status('连接失败：' + err.message, { error: true })
  }
  ws.onopen = () => {
    setWsDot(true)
    status('实时告警源已连接：' + url)
  }
  ws.onclose = () => {
    setWsDot(false)
    ws = null
    if (wsWanted) wsRetry = setTimeout(openWs, 3000) // 自动重连
  }
  ws.onerror = () => setWsDot(false)
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data)
      if (m.type === 'alarm' && m.id) setAlarmById(m.id, m.level || 'alarm', m.message || '')
      else if (m.type === 'clear' && m.id && deviceLayer.clearAlarm(m.id)) {
        pushAlarm(m.id, 'info', '告警恢复，状态正常', false)
      }
    } catch {}
  }
}

function closeWs() {
  wsWanted = false
  clearTimeout(wsRetry)
  ws?.close()
  ws = null
  setWsDot(false)
  $('btn-ws').textContent = '连接'
  status('已断开实时告警源')
}

$('btn-ws').addEventListener('click', () => (wsWanted ? closeWs() : openWs()))

// ── 回放 ───────────────────────────────────
$('btn-play').addEventListener('click', () => {
  if (viewer.isPlaying()) viewer.pauseReplay()
  else viewer.resumeReplay()
  $('btn-play').textContent = viewer.isPlaying() ? '⏸ 暂停' : '▶ 播放'
})
$('sel-speed').addEventListener('change', (e) => viewer.setReplaySpeed(+e.target.value))

// ── 视图与导出 ─────────────────────────────
$('btn-fit').addEventListener('click', () => viewer.fitView())
$('btn-top').addEventListener('click', () => viewer.topView())
$('btn-iso').addEventListener('click', () => viewer.isoView())
$('btn-shot').addEventListener('click', () => viewer.screenshot())
$('btn-export').addEventListener('click', exportVisiblePCD)

// ── PCD 导出（binary，含原始坐标恢复） ──────
function exportVisiblePCD() {
  const visible = [...viewer.layers.values()].filter((l) => l.visible)
  if (!visible.length) return status('没有可见图层可导出', { error: true })
  const hasColor = visible.some((l) => l.data.colors)
  const hasInt = visible.some((l) => l.data.intensities)
  const fields = ['x', 'y', 'z']
  if (hasInt) fields.push('intensity')
  if (hasColor) fields.push('rgb')
  const step = fields.length * 4
  const total = visible.reduce((s, l) => s + l.data.count, 0)

  const header =
    `# .PCD v0.7 - Point Cloud Data file format\n` +
    `VERSION 0.7\nFIELDS ${fields.join(' ')}\n` +
    `SIZE ${fields.map(() => 4).join(' ')}\nTYPE ${fields.map(() => 'F').join(' ')}\n` +
    `COUNT ${fields.map(() => 1).join(' ')}\nWIDTH ${total}\nHEIGHT 1\n` +
    `VIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${total}\nDATA binary\n`

  const body = new ArrayBuffer(total * step)
  const dv = new DataView(body)
  const xyz = [0, 0, 0]
  let p = 0
  for (const l of visible) {
    const d = l.data
    for (let i = 0; i < d.count; i++, p++) {
      const o = p * step
      restorePoint(d, i, xyz) // 恢复文件原始坐标（含朝向逆转）
      dv.setFloat32(o, xyz[0], true)
      dv.setFloat32(o + 4, xyz[1], true)
      dv.setFloat32(o + 8, xyz[2], true)
      let c = 12
      if (hasInt) {
        dv.setFloat32(o + c, d.intensities ? d.intensities[i] : 0, true)
        c += 4
      }
      if (hasColor) {
        let packed = 0
        if (d.colors) {
          packed =
            (Math.round(d.colors[i * 3] * 255) << 16) |
            (Math.round(d.colors[i * 3 + 1] * 255) << 8) |
            Math.round(d.colors[i * 3 + 2] * 255)
        }
        dv.setUint32(o + c, packed, true) // float 比特位打包颜色（PCL 约定）
      }
    }
  }

  const blob = new Blob([new TextEncoder().encode(header), body], { type: 'application/octet-stream' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'solid-twin-export.pcd'
  a.click()
  URL.revokeObjectURL(a.href)
  status(`已导出 ${fmt(total)} 点 → solid-twin-export.pcd`)
}

// ── 启动 ───────────────────────────────────
runSimulation()
