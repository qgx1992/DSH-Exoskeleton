/**
 * 勘察：顶部 y∈[0,36] 那一带（overlay 高度）在横向各位置到底是什么元素，
 * 以及注入的 `-webkit-app-region: drag` 到底落在哪些元素上。
 *
 * 目的：回答「为什么只有左侧边栏顶部能拖动窗口、中间主体顶部拖不动」。
 * 只读 DOM / 计算样式，不改任何东西。
 */
const { app, BrowserWindow, Menu, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')
const OVERLAY_H = 36

const PROBE = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) } }
  const cls = (el) => String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).join(' ')
  const short = (el) => el.tagName.toLowerCase() + (cls(el) ? '.' + cls(el) : '')
  const out = { W: window.innerWidth, H: window.innerHeight }

  // 1) 顶端那一带里、横向排布的元素（跳过叶子文本节点）
  const band = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.bottom <= 0 || r.top >= ${OVERLAY_H}) continue
    if (r.width < 8 || r.height < 8) continue
    const cs = getComputedStyle(el)
    band.push({
      sel: short(el), rect: R(el),
      drag: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || '(none)',
      bg: cs.backgroundColor, text: (el.textContent || '').trim().slice(0, 30),
      pos: cs.position, z: cs.zIndex
    })
  }
  out.band = band

  // 2) 注入的 drag 规则实际命中哪些元素
  const dragEls = []
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    const v = cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region')
    if (v && v !== 'none') dragEls.push({ sel: short(el), rect: R(el), value: v })
  }
  out.dragEls = dragEls

  // 3) 在 y=18 横向扫描：每个 x 处最上层元素（elementFromPoint）
  const scan = []
  for (const x of [10, 60, 140, 200, 260, 300, 340, 420, 600, 900, Math.round(window.innerWidth / 2), window.innerWidth - 300, window.innerWidth - 160, window.innerWidth - 60]) {
    if (x < 0 || x >= window.innerWidth) continue
    const el = document.elementFromPoint(x, 18)
    if (!el) { scan.push({ x, el: null }); continue }
    const cs = getComputedStyle(el)
    // 沿祖先链看有没有 drag 祖先
    let dragAncestor = null
    let cur = el
    for (let i = 0; cur && i < 12; i++, cur = cur.parentElement) {
      const v = getComputedStyle(cur).webkitAppRegion || getComputedStyle(cur).getPropertyValue('-webkit-app-region')
      if (v && v !== 'none') { dragAncestor = { sel: short(cur), value: v }; break }
    }
    scan.push({ x, el: short(el), rect: R(el), dragSelf: cs.webkitAppRegion || '(none)', dragAncestor, text: (el.textContent || '').trim().slice(0, 24) })
  }
  out.scan = scan

  // 4) logoRow 结构（注入规则挂在这里）
  const logo = document.querySelector('[class*="logoRow"]')
  out.logoRow = logo ? {
    rect: R(logo),
    kids: [...logo.children].map((k) => ({ sel: short(k), rect: R(k), drag: getComputedStyle(k).webkitAppRegion, role: k.getAttribute('role'), aria: k.getAttribute('aria-label') }))
  } : null

  // 5) 侧边栏 / 主体分界（侧边栏宽）
  const col = document.querySelector('[class*="sidebarCol"]')
  out.sidebar = col ? { rect: R(col) } : null

  // 6) 中间主体顶部那一行的容器是谁
  const center = document.querySelector('[class*="centerCol"]') || document.querySelector('main')
  out.center = center ? {
    sel: short(center), rect: R(center),
    firstKids: [...center.children].slice(0, 4).map((k) => ({ sel: short(k), rect: R(k) })),
    kidsAtTop: [...center.children].filter((k) => k.getBoundingClientRect().top < ${OVERLAY_H}).map((k) => ({ sel: short(k), rect: R(k), drag: getComputedStyle(k).webkitAppRegion, bg: getComputedStyle(k).backgroundColor }))
  } : null
  return out
})()`

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const log = path.join(app.getPath('temp'), 'probe-drag.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  const child = spawn(process.env.DSH_PROBE_NODE || 'node', [KERNEL_BIN, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    stdio: ['ignore', fd, fd], windowsHide: true
  })
  let url = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const m = fs.readFileSync(log, 'utf-8').match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\S*)/)
      if (m) { url = m[1]; break }
    } catch { /* noop */ }
  }
  if (!url) { console.error('内核未就绪'); app.exit(1); return }
  console.log('kernel url =', url)

  const win = new BrowserWindow({
    show: true, width: 1440, height: 854, x: 40, y: 40,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#151517', symbolColor: '#f9fafb', height: OVERLAY_H }
  })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  const [cw, ch] = win.getContentSize()
  view.setBounds({ x: 0, y: 0, width: cw, height: ch })
  await view.webContents.loadURL(url)
  await new Promise((r) => setTimeout(r, 9000))

  // 关键：注入与生产同款的拖拽区 CSS（生产在 injectSidebarEntry 里下发）
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const modPath = path.join(require('os').tmpdir(), `dsh-wse-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: modPath, logLevel: 'error'
  })
  const { buildTopDragRegionCss } = require(modPath)
  await view.webContents.insertCSS(buildTopDragRegionCss(OVERLAY_H), { cssOrigin: 'user' })
  console.log('已注入生产同款拖拽区 CSS')
  await new Promise((r) => setTimeout(r, 500))

  // 打开一个会话，让 header 出现（否则主体顶部是空态）
  const clicked = await view.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')]
    for (const r of rows) { const t = (r.textContent || '').trim(); if (t && t.length < 200 && !/展开|工作区|其余/.test(t)) { r.click(); return t.slice(0, 40) } }
    return null
  })()`)
  console.log('点击会话 =', JSON.stringify(clicked))
  await new Promise((r) => setTimeout(r, 3500))

  const r = await view.webContents.executeJavaScript(PROBE)
  console.log('\n窗口内容区 =', r.W, 'x', r.H, ' overlay 高 =', OVERLAY_H)
  console.log('侧边栏 =', JSON.stringify(r.sidebar))
  console.log('\n=========== logoRow（注入 drag 的地方） ===========')
  console.log(JSON.stringify(r.logoRow, null, 2))
  console.log('\n=========== 顶部带内元素（y<36） ===========')
  for (const b of r.band) {
    console.log(`  ${b.sel}  rect=${JSON.stringify(b.rect)} drag=${b.drag} pos=${b.pos} z=${b.z} bg=${b.bg} text="${b.text}"`)
  }
  console.log('\n=========== 计算样式里 app-region != none 的元素 ===========')
  if (r.dragEls.length === 0) console.log('  （无！注入规则没有命中任何元素）')
  for (const d of r.dragEls) console.log(`  ${d.sel} rect=${JSON.stringify(d.rect)} value=${d.value}`)
  console.log('\n=========== y=18 横向扫描（该点最上层元素 + 是否有 drag 祖先） ===========')
  for (const s of r.scan) {
    console.log(`  x=${String(s.x).padStart(5)}  ${s.el}  rect=${JSON.stringify(s.rect)} dragSelf=${s.dragSelf} dragAncestor=${JSON.stringify(s.dragAncestor)} "${s.text}"`)
  }
  console.log('\n=========== 中间主体容器 ===========')
  console.log(JSON.stringify(r.center, null, 2))

  try { child.kill() } catch { /* noop */ }
  app.exit(0)
})
