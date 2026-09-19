/**
 * 勘察（第三轮）：把底部区的真实 HTML 片段与关键计算样式抓下来，
 * 为「CSS 重塑成一行 4 个小按钮」方案定稿（不搬动任何节点）。
 *
 * 关注：
 *   ① settingsArea/triggerRow/trigger 的 outerHTML（图标 + 标签结构、aria、popup 标记）
 *   ② footerActions 的 outerHTML（ui-tools 工具条 + 壳注入按钮）
 *   ③ footArea / footerActions / sidebarCol 的 overflow、flex 相关计算样式
 *   ④ 折叠/展开按钮官方 aria-label 文案（用于壳侧转发点击）
 *
 * 只读。用法：npx electron scripts/probe/probe-footer-html.cjs
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

function loadEntryModule () {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `footer-html-entry-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error'
  })
  return require(out)
}

const PROBE = `(() => {
  const cs = (el, props) => { const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c[p]; return o }
  const out = {}
  const foot = document.querySelector('[class*="footArea"]')
  const actions = document.querySelector('[class*="footerActions"]')
  const settings = document.querySelector('[class*="settingsArea"]')
  const row = document.querySelector('[class*="triggerRow"]')
  const trigger = row ? row.querySelector('button') : null
  const col = document.querySelector('[class*="sidebarCol"]')

  out.html = {
    footArea: foot ? foot.outerHTML.slice(0, 3000) : null,
    settingsArea: settings ? settings.outerHTML.slice(0, 3000) : null,
    triggerRow: row ? row.outerHTML.slice(0, 2500) : null,
    trigger: trigger ? trigger.outerHTML.slice(0, 2000) : null
  }
  const P = ['overflow', 'overflowX', 'overflowY', 'display', 'flexDirection', 'flexWrap', 'alignItems', 'gap', 'width', 'height', 'padding', 'margin', 'position', 'minWidth']
  out.styles = {
    sidebarCol: col ? cs(col, P) : null,
    footArea: foot ? cs(foot, P) : null,
    footerActions: actions ? cs(actions, P) : null,
    settingsArea: settings ? cs(settings, P) : null,
    triggerRow: row ? cs(row, P) : null,
    trigger: trigger ? cs(trigger, [...P, 'fontSize', 'borderRadius', 'color', 'background']) : null
  }
  // 官方「折叠/展开」按钮（壳侧转发用）
  out.collapseButtons = [...document.querySelectorAll('[class*="footArea"] button')]
    .map((b) => ({ aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), text: (b.textContent || '').trim() }))
  // 设置行里除按钮外还有别的节点吗
  out.rowChildren = row ? [...row.children].map((k) => k.tagName + '.' + String(k.className || '')) : null
  // trigger 的直接子节点
  out.triggerChildren = trigger ? [...trigger.children].map((k) => ({ tag: k.tagName, cls: String(k.className || ''), ariaHidden: k.getAttribute('aria-hidden'), text: (k.textContent || '').trim().slice(0, 20) })) : null
  return out
})()`

app.whenReady().then(async () => {
  const log = path.join(app.getPath('temp'), 'dsh-footer-html.log')
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

  const mod = loadEntryModule()
  await view.webContents.executeJavaScript(mod.buildSidebarEntryScript()).catch(() => {})
  await new Promise((r) => setTimeout(r, 800))

  const data = await view.webContents.executeJavaScript(PROBE)
  const outFile = path.join(__dirname, 'out', 'sidebar-footer-html.json')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2))
  console.log('完整结构见:', outFile)

  console.log('\n===== HTML: settingsArea =====\n' + data.html.settingsArea)
  console.log('\n===== HTML: triggerRow =====\n' + data.html.triggerRow)
  console.log('\n===== HTML: footArea =====\n' + data.html.footArea)
  console.log('\n===== styles =====\n' + JSON.stringify(data.styles, null, 1))
  console.log('\n===== 折叠/展开按钮 =====\n' + JSON.stringify(data.collapseButtons, null, 1))
  console.log('\n===== trigger 子节点 =====\n' + JSON.stringify(data.triggerChildren, null, 1))

  try { child.kill() } catch { /* noop */ }
  app.exit(0)
})
