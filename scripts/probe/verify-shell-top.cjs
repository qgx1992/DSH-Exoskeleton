/**
 * 端到端验证：新窗口形态（titleBarStyle:'hidden' + titleBarOverlay）+ 侧边栏入口注入 + 顶部拖拽区。
 * 覆盖：
 *   ① File/Edit/View 菜单已消失（Menu.setApplicationMenu(null)）
 *   ② 内容从 y=0 起（窗口高-内容高 = 0）
 *   ③ 顶部拖拽区 CSS 生效（logoRow 上 -webkit-app-region: drag）
 *   ④ 拖拽区不破坏 logo 点击（按钮仍为 no-drag）
 *   ⑤ 侧边栏「网页版 DeepSeek」入口仍正常注入
 */
const { app, BrowserWindow, Menu, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')

function loadEntryModule() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `entry-verify-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error'
  })
  return require(out)
}

app.whenReady().then(async () => {
  const mod = loadEntryModule()
  Menu.setApplicationMenu(null)

  const log = path.join(app.getPath('temp'), 'e2e.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  const child = spawn('node', [KERNEL_BIN, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    stdio: ['ignore', fd, fd], windowsHide: true
  })
  let url = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { const m = fs.readFileSync(log, 'utf-8').match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\S*)/); if (m) { url = m[1]; break } } catch {}
  }
  if (!url) { console.error('内核未就绪'); app.exit(1); return }

  // 新窗口形态
  const win = new BrowserWindow({
    show: true, width: 1400, height: 880, x: 40, y: 40,
    backgroundColor: '#0b0f17',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0f17', symbolColor: '#c9d1d9', height: 36 }
  })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  const [cw, ch] = win.getContentSize()
  view.setBounds({ x: 0, y: 0, width: cw, height: ch })

  const received = []
  view.webContents.on('ipc-message', (_e, channel, ...args) => {
    if (channel === 'dsh-exo') received.push(String(args[0]))
  })

  await view.webContents.loadURL(url)
  await new Promise((r) => setTimeout(r, 9000))

  // 注入拖拽区 CSS + 侧边栏入口（与主进程同路径）
  await view.webContents.insertCSS(mod.buildTopDragRegionCss(36), { cssOrigin: 'user' }).catch(() => {})
  await view.webContents.executeJavaScript(mod.buildSidebarEntryScript())
  await new Promise((r) => setTimeout(r, 800))

  // ① 菜单
  const menuNow = Menu.getApplicationMenu()
  // ② 几何
  const cb = win.getContentBounds()
  const wb = win.getBounds()
  // ③④ 拖拽区生效 + 按钮仍可点
  const dragInfo = await view.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[class*="logoRow"]')
    if (!row) return { found: false }
    const rowRegion = getComputedStyle(row).webkitAppRegion
    const btn = row.querySelector('button')
    const btnRegion = btn ? getComputedStyle(btn).webkitAppRegion : null
    return {
      found: true,
      rowRegion,
      btnRegion,
      btnAria: btn ? btn.getAttribute('aria-label') : null,
      rowRect: (() => { const r = row.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) } })()
    }
  })()`)
  // ⑤ 入口
  const entry = await view.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('dsh-exo-webpanel-entry')
    const slot = document.querySelector('[data-slot="sidebar.footer.action"]')
    return { exists: !!b, inSlot: !!(b && slot && slot.contains(b)), text: b ? b.textContent.trim() : null }
  })()`)
  await view.webContents.executeJavaScript(`document.getElementById('dsh-exo-webpanel-entry').click()`)
  await new Promise((r) => setTimeout(r, 800))

  console.log('\n========== 端到端结果 ==========')
  console.log('① 应用菜单      :', menuNow ? menuNow.items.map((i) => i.label) : 'null（File/Edit/View 已消失）')
  console.log('② 窗口高-内容高 :', wb.height - cb.height, '（0 = 内容从 y=0 起，顶部为 DSH 品牌行）')
  console.log('③ 顶部拖拽区    :', JSON.stringify(dragInfo))
  console.log('④ 入口注入      :', JSON.stringify(entry))
  console.log('⑤ 桥收到        :', JSON.stringify(received))

  const pass =
    menuNow === null &&
    wb.height - cb.height === 0 &&
    dragInfo.found === true &&
    dragInfo.rowRegion === 'drag' &&
    dragInfo.btnRegion === 'no-drag' &&
    entry.exists && entry.inSlot &&
    received.includes('webpanel:toggle')
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项')

  // 视觉取证
  try {
    const shot = await view.webContents.capturePage({ x: 0, y: 0, width: 700, height: 110 })
    const f = path.join(os.tmpdir(), 'e2e-top.png')
    fs.writeFileSync(f, shot.toPNG())
    console.log('SHOT=' + f)
  } catch { /* noop */ }

  try { child.kill() } catch {}
  app.exit(pass ? 0 : 1)
})
