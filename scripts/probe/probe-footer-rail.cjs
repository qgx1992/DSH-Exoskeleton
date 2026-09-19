/**
 * 勘察（第二轮）：为「底部一排 4 个小按钮」方案取证，回答三个问题：
 *   ① 工作区分组的折叠/展开状态在 DOM 上有没有可读标记（aria-expanded 等）——
 *      决定壳能否用一个按钮合并官方的「折叠全部/展开全部」；
 *   ② 侧边栏收起成 56px 窄条（rail）后，footArea / footerActions / settingsArea 的形态；
 *   ③ 底部区各层的可用宽度（排 4 个 28px 小按钮够不够）。
 *
 * 只读，不改任何东西。用法：npx electron scripts/probe/probe-footer-rail.cjs
 */
const { app, BrowserWindow, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })
setTimeout(() => { console.error('[probe] 硬超时'); app.exit(2) }, 180000)

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')

const PROBE_EXPAND = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } }
  const cls = (el) => String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).join(' ')
  const short = (el) => el.tagName.toLowerCase() + (cls(el) ? '.' + cls(el) : '')
  const out = {}

  // 工作区区域里所有带 aria-expanded / ariaExpanded 的元素
  const exp = []
  for (const el of document.querySelectorAll('[aria-expanded]')) {
    exp.push({ sel: short(el), aria: el.getAttribute('aria-expanded'), ariaLabel: el.getAttribute('aria-label'), rect: R(el), text: (el.textContent || '').trim().slice(0, 24) })
  }
  out.ariaExpanded = exp

  // 工作区列表容器结构（找分组头）
  const region = document.querySelector('[slot="sidebar.workspaces"]')
  const rows = []
  if (region) {
    for (const el of region.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.height < 12 || r.height > 60 || r.width < 80) continue
      const cs = getComputedStyle(el)
      if (cs.cursor !== 'pointer' && el.tagName !== 'BUTTON') continue
      rows.push({ sel: short(el), rect: R(el), tag: el.tagName, role: el.getAttribute('role'), aria: el.getAttribute('aria-label'), expanded: el.getAttribute('aria-expanded'), text: (el.textContent || '').trim().slice(0, 30) })
    }
  }
  out.clickableRows = rows.slice(0, 30)

  // 底部各层宽度
  const pick = (sel) => { const el = document.querySelector(sel); return el ? { sel, rect: R(el), display: getComputedStyle(el).display, width: getComputedStyle(el).width } : null }
  out.layers = [
    pick('[class*="footArea"]'),
    pick('[class*="footerActions"]'),
    pick('[class*="settingsArea"]'),
    pick('[class*="triggerRow"]')
  ]
  return out
})()`

const PROBE_RAIL = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } }
  const cls = (el) => String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).join(' ')
  const short = (el) => el.tagName.toLowerCase() + (cls(el) ? '.' + cls(el) : '')
  const out = { sidebarWidth: Math.round((document.querySelector('[class*="sidebarCol"]') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width) }
  const pick = (sel) => { const el = document.querySelector(sel); return el ? { sel, rect: R(el), display: getComputedStyle(el).display, width: getComputedStyle(el).width, cls: cls(el) } : null }
  out.layers = [
    pick('[class*="footArea"]'),
    pick('[class*="footerActions"]'),
    pick('[class*="settingsArea"]'),
    pick('[class*="triggerRow"]'),
    pick('[class*="trigger"]')
  ]
  out.buttons = [...document.querySelectorAll('[class*="footArea"] button')].map((b) => ({ sel: short(b), rect: R(b), aria: b.getAttribute('aria-label'), text: (b.textContent || '').trim().slice(0, 20) }))
  out.slotHosts = ['sidebar.footer.action', 'sidebar.settings'].map((s) => { const el = document.querySelector('[data-slot="' + s + '"]'); return { slot: s, parent: el && el.parentElement ? short(el.parentElement) : null, parentRect: el && el.parentElement ? R(el.parentElement) : null } })
  return out
})()`

app.whenReady().then(async () => {
  const log = path.join(app.getPath('temp'), 'dsh-footer-rail.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  const child = spawn('node', [KERNEL_BIN, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
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

  const win = new BrowserWindow({ show: true, width: 1440, height: 900, x: 40, y: 40 })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
  await view.webContents.loadURL(url)
  await new Promise((r) => setTimeout(r, 10000))

  const expanded = await view.webContents.executeJavaScript(PROBE_EXPAND)
  console.log('\n========== 展开态 ==========')
  console.log('aria-expanded 元素:', JSON.stringify(expanded.ariaExpanded, null, 1))
  console.log('可点击行(前 30):', JSON.stringify(expanded.clickableRows?.slice(0, 12), null, 1))
  console.log('底部各层:', JSON.stringify(expanded.layers, null, 1))

  // 收起侧边栏：点官方 toggle
  const clicked = await view.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('button')]
    const t = btns.find((b) => /收起侧边栏|Collapse sidebar/.test(b.getAttribute('aria-label') || ''))
    if (!t) return 'no-toggle'
    t.click()
    return 'clicked'
  })()`)
  console.log('\n收起动作:', clicked)
  await new Promise((r) => setTimeout(r, 1500))

  const rail = await view.webContents.executeJavaScript(PROBE_RAIL)
  console.log('\n========== 收起态（rail）==========')
  console.log(JSON.stringify(rail, null, 1))

  const f = path.join(app.getPath('temp'), 'sidebar-rail.png')
  try {
    const shot = await view.webContents.capturePage({ x: 0, y: 600, width: 300, height: 300 })
    fs.writeFileSync(f, shot.toPNG())
    console.log('SHOT=' + f)
  } catch { /* noop */ }

  try { child.kill() } catch { /* noop */ }
  app.exit(0)
})
