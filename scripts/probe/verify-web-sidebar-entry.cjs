/**
 * 实测验证：侧边栏「网页版 DeepSeek」入口注入是否真的生效。
 * 覆盖三点：① 按钮插进官方 sidebar.footer.action 锚点；② 点击经 __dshExo 桥回壳；
 * ③ 侧边栏宽度可实测（网页版视图定位用）。
 * 使用真实内核 + 真实 dsh-view preload，非模拟。
 */
const { app, BrowserWindow, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => {
  console.error('[verify] uncaught:', e && e.message)
  app.exit(1)
})

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')

function compileEntryModule() {
  // 用 esbuild 的 JS API（不能用 execFileSync + esbuild bin：electron 下 process.execPath 是 electron.exe，
  // 它不会按 node 脚本跑 esbuild）
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `dsh-sidebar-entry-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'error'
  })
  return require(out)
}

app.whenReady().then(async () => {
  const mod = compileEntryModule()
  const log = path.join(app.getPath('temp'), 'dsh-sidebar-verify.log')
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

  const win = new BrowserWindow({ show: true, width: 1440, height: 900, x: 40, y: 40 })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 })

  // 壳侧收到的页面消息（模拟 window-manager 的 ipc-message 监听）
  const received = []
  view.webContents.on('ipc-message', (_e, channel, ...args) => {
    if (channel === 'dsh-exo') received.push({ channel: String(args[0]), payload: args[1] })
  })

  await view.webContents.loadURL(url)
  await new Promise((r) => setTimeout(r, 9000))

  // ① 注入
  const injected = await view.webContents.executeJavaScript(mod.buildSidebarEntryScript())
  await new Promise((r) => setTimeout(r, 800))

  const presence = await view.webContents.executeJavaScript(`(() => {
    const btn = document.getElementById('dsh-exo-webpanel-entry')
    const slot = document.querySelector('[data-slot="sidebar.footer.action"]')
    const r = btn ? btn.getBoundingClientRect() : null
    return {
      injectedMarker: window.__dshExoWebPanelInstalled === true,
      hasBridge: typeof window.__dshExo === 'object' && typeof window.__dshExo.send === 'function',
      buttonExists: !!btn,
      insideOfficialSlot: !!(btn && slot && slot.contains(btn)),
      buttonText: btn ? btn.textContent.trim() : null,
      rect: r ? { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
      // 与同槽位第三方行对比（应同列、位于其上方或下方）
      slotText: slot ? slot.textContent.trim().slice(0, 60) : null
    }
  })()`)

  // ② 点击 → 桥回壳
  await view.webContents.executeJavaScript(`document.getElementById('dsh-exo-webpanel-entry').click()`)
  await new Promise((r) => setTimeout(r, 900))

  // ③ 侧边栏宽度实测
  const sidebarWidth = await view.webContents.executeJavaScript(mod.measureSidebarWidthScript())

  // ④ 选中态回写
  await view.webContents.executeJavaScript(mod.setSidebarEntryActiveScript(true))
  await new Promise((r) => setTimeout(r, 400))
  const activeState = await view.webContents.executeJavaScript(
    `document.getElementById('dsh-exo-webpanel-entry').getAttribute('data-active')`
  )

  // ⑤ 自愈：手动删掉按钮，看观察器是否补回
  await view.webContents.executeJavaScript(
    `document.getElementById('dsh-exo-webpanel-entry').remove(); true`
  )
  await new Promise((r) => setTimeout(r, 1200))
  const healed = await view.webContents.executeJavaScript(
    `!!document.getElementById('dsh-exo-webpanel-entry')`
  )

  console.log('\n===== 实测结果 =====')
  console.log('① 注入脚本返回 :', injected)
  console.log('② 入口状态     :', JSON.stringify(presence, null, 2))
  console.log('③ 桥收到的消息 :', JSON.stringify(received))
  console.log('④ 侧边栏宽度   :', sidebarWidth)
  console.log('⑤ 选中态回写   :', activeState)
  console.log('⑥ 删除后自愈   :', healed)

  const pass =
    presence.buttonExists &&
    presence.insideOfficialSlot &&
    presence.hasBridge &&
    received.some((m) => m.channel === 'webpanel:toggle') &&
    typeof sidebarWidth === 'number' &&
    sidebarWidth > 100 &&
    activeState === '1' &&
    healed === true
  console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项')

  try { child.kill() } catch { /* noop */ }
  app.exit(pass ? 0 : 1)
})
