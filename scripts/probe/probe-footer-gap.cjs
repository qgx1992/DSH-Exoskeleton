/**
 * 勘察：第三方插槽元素（dsh-cost-meter 余额栈等）的横向占位 ——
 * 为什么左侧空了一截？
 *
 * 假设：壳的布局把 footerActions 按 1:3 分栏（设置占左 1/4），第三方元素落在该容器的
 * 右 3/4，于是它左侧（x ∈ [footArea.left, footerActions.left)）看起来空了一截。
 *
 * 只读 DOM / 计算样式，不改任何东西。用法：
 *   DSH_HOME=<临时 home> npx electron scripts/probe/probe-footer-gap.cjs
 */
const { app, BrowserWindow, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })
setTimeout(() => { console.error('[probe] 硬超时'); app.exit(2) }, 240000)

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')

function loadModule () {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `foot-gap-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error'
  })
  return require(out)
}

app.whenReady().then(async () => {
  const mod = loadModule()
  const log = path.join(app.getPath('temp'), 'foot-gap.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  const child = spawn('node', [KERNEL_BIN, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    stdio: ['ignore', fd, fd], windowsHide: true, env: process.env
  })
  let url = null
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { const m = fs.readFileSync(log, 'utf-8').match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\S*)/); if (m) { url = m[1]; break } } catch { /* noop */ }
  }
  if (!url) { console.error('内核未就绪'); app.exit(1); return }

  const win = new BrowserWindow({ show: true, width: 1440, height: 900, x: 40, y: 40 })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 })

  // 与生产/验证脚本同款清理（否则累积 dsh-auth cookie 会让插件加载失败）
  const viewSession = view.webContents.session
  await viewSession.clearCache().catch(() => {})
  const cookies = await viewSession.cookies.get({ domain: '127.0.0.1' }).catch(() => [])
  const auth = cookies
    .filter((c) => typeof c.name === 'string' && c.name.startsWith('dsh-auth-'))
    .sort((a, b) => (b.expirationDate ?? 0) - (a.expirationDate ?? 0))
  for (const c of auth.slice(2)) {
    await viewSession.cookies.remove(`http://${c.domain}${c.path ?? '/'}`, c.name).catch(() => {})
  }

  await view.webContents.loadURL(url)
  let ready = false
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (i > 0 && i % 20 === 0) {
      const failed = await view.webContents.executeJavaScript(
        `/failed to load plugins/i.test(document.body ? document.body.innerText : '')`
      ).catch(() => false)
      if (failed) { try { view.webContents.reloadIgnoringCache() } catch { /* noop */ } ; continue }
    }
    ready = await view.webContents.executeJavaScript(
      `!!document.querySelector('[class*="footArea"]')`
    ).catch(() => false)
    if (ready) break
  }
  console.log('底部区就绪:', ready)
  if (!ready) { try { child.kill() } catch { /* noop */ } ; app.exit(3); return }

  await view.webContents.executeJavaScript(mod.buildSidebarEntryScript())
  await view.webContents.executeJavaScript(mod.buildSidebarFooterScript())
  await new Promise((r) => setTimeout(r, 1200))
  await view.webContents.executeJavaScript(`window.__dshExoFootSync()`)
  await new Promise((r) => setTimeout(r, 600))

  const out = await view.webContents.executeJavaScript(`(function () {
    var R = function (el) { var r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } }
    var foot = document.querySelector('[class*="footArea"]')
    var actions = document.querySelector('[class*="footerActions"]')
    var settings = document.querySelector('[class*="settingsArea"]')
    var res = { foot: R(foot), actions: R(actions), settings: R(settings) }
    // 第三方插槽元素（排除壳的组）
    res.thirdParty = []
    var slot = document.querySelector('[data-slot="sidebar.footer.action"]')
    Array.prototype.forEach.call(slot.children, function (el) {
      if (el.classList.contains('dsh-exo-foot-group')) return
      var r = el.getBoundingClientRect()
      var cs = getComputedStyle(el)
      res.thirdParty.push({
        cls: String(el.className || '').slice(0, 50),
        rect: R(el), display: cs.display, position: cs.position,
        marginLeft: cs.marginLeft, marginRight: cs.marginRight, paddingLeft: cs.paddingLeft,
        parent: el.parentElement ? String(el.parentElement.className || '').slice(0, 40) : null,
        // 该元素自己的子块（真正画出来的内容）
        kids: Array.prototype.slice.call(el.children).map(function (k) {
          var kr = k.getBoundingClientRect()
          var kcs = getComputedStyle(k)
          return { cls: String(k.className || '').slice(0, 40), rect: R(k), pad: kcs.padding, margin: kcs.margin, text: (k.textContent || '').trim().slice(0, 18) }
        })
      })
    })
    // 壳的组
    var group = document.querySelector('.dsh-exo-foot-group')
    res.group = group ? R(group) : null
    // 设置按钮
    var st = document.querySelector('[class*="triggerRow"] > button')
    res.settingsBtn = st ? R(st) : null
    // 底栏内每个可见文本节点的横向范围（看画出来的内容从哪开始）
    res.painted = []
    Array.prototype.forEach.call(foot.querySelectorAll('*'), function (el) {
      if (el.children.length > 0) return
      var t = (el.textContent || '').trim()
      if (!t) return
      var r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      res.painted.push({ text: t.slice(0, 18), rect: R(el) })
    })
    return res
  })()`)

  console.log('\n===== 底栏横向几何 =====')
  console.log(JSON.stringify(out, null, 1))
  const f = path.join(app.getPath('temp'), 'footer-gap.png')
  try {
    const shot = await view.webContents.capturePage({
      x: out.foot.l, y: Math.max(0, out.foot.t - 4), width: out.foot.w, height: out.foot.h + 8
    })
    fs.writeFileSync(f, shot.toPNG())
    console.log('SHOT=' + f)
  } catch { /* noop */ }

  try { child.kill() } catch { /* noop */ }
  app.exit(0)
})
