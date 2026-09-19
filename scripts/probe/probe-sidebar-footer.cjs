/**
 * 勘察：DSH 左侧边栏「底部区（footArea）」当前到底渲染了哪些行/按钮。
 *
 * 目的：为「把底部设置按钮改成小按钮、横排容纳 4 个」提供实测依据——
 * 需要知道 footer 里真实的元素、层级、尺寸、类名（哈希）、插槽标记，
 * 以及注入的「网页版 DeepSeek」按钮落在哪一行。
 *
 * 只读 DOM / 计算样式，不改任何东西（不注入生产脚本，只截 DOM 结构）。
 * 用法：npx electron scripts/probe/probe-sidebar-footer.cjs
 */
const { app, BrowserWindow, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })
setTimeout(() => { console.error('[probe] 硬超时'); app.exit(2) }, 180000)

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')

/** 编译壳侧注入模块（与生产同路径），让勘察看到真实运行时的底部区 */
function loadEntryModule () {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(require('os').tmpdir(), `footer-entry-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error'
  })
  return require(out)
}

const PROBE = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } }
  const cls = (el) => String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 3).join(' ')
  const short = (el) => el.tagName.toLowerCase() + (cls(el) ? '.' + cls(el) : '') +
    (el.getAttribute && el.getAttribute('data-slot') ? '[slot=' + el.getAttribute('data-slot') + ']' : '')
  const out = { url: location.href, W: window.innerWidth, H: window.innerHeight }

  // 1) 侧边栏列容器（哈希类名 sidebarCol）
  const col = document.querySelector('[class*="sidebarCol"]')
  out.sidebarCol = col ? { cls: cls(col), rect: R(col) } : null

  // 2) footArea / settingsArea / footerActions：底部区三段
  const foot = document.querySelector('[class*="footArea"]')
  out.footArea = foot ? { cls: cls(foot), rect: R(foot), kids: [...foot.children].map((k) => ({ sel: short(k), rect: R(k) })) } : null

  // 3) 递归 dump footArea 内部（深度 4），带尺寸/文本/role
  function dump (el, depth) {
    if (depth > 4) return null
    const cs = getComputedStyle(el)
    return {
      sel: short(el),
      rect: R(el),
      display: cs.display,
      role: el.getAttribute && el.getAttribute('role'),
      aria: el.getAttribute && el.getAttribute('aria-label'),
      title: el.getAttribute && el.getAttribute('title'),
      text: (el.textContent || '').trim().slice(0, 40),
      kids: [...el.children].map((k) => dump(k, depth + 1)).filter(Boolean)
    }
  }
  out.footTree = foot ? [...foot.children].map((k) => dump(k, 0)) : null

  // 4) 底部区所有 button / [role=button]（候选「4 个小按钮」）
  const btns = []
  const scope = foot || document
  for (const el of scope.querySelectorAll('button, [role="button"], a')) {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const cs = getComputedStyle(el)
    btns.push({
      sel: short(el), rect: R(el),
      aria: el.getAttribute('aria-label'), title: el.getAttribute('title'),
      text: (el.textContent || '').trim().slice(0, 30),
      bg: cs.backgroundColor, radius: cs.borderRadius, fontSize: cs.fontSize,
      display: cs.display, width: cs.width, height: cs.height
    })
  }
  out.footerButtons = btns

  // 5) footer 内所有 data-slot 标记（官方插槽锚点）
  out.slots = [...document.querySelectorAll('[data-slot]')].map((el) => ({ slot: el.getAttribute('data-slot'), sel: short(el), rect: R(el), display: getComputedStyle(el).display }))

  // 6) 底部区里第三方行（余额/工具条）的类名与尺寸
  const marks = []
  for (const el of (foot ? foot.querySelectorAll('*') : [])) {
    const t = (el.textContent || '').trim()
    if (!t || t.length > 30) continue
    if (el.children.length > 0) continue
    marks.push({ sel: short(el), rect: R(el), text: t })
  }
  out.leafTexts = marks
  return out
})()`

app.whenReady().then(async () => {
  const log = path.join(app.getPath('temp'), 'dsh-footer-probe.log')
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

  // 注入生产脚本（网页版入口 + 顶部拖拽区），使勘察结果 = 真实运行时
  const mod = loadEntryModule()
  await view.webContents.insertCSS(mod.buildTopDragRegionCss(36), { cssOrigin: 'user' }).catch(() => {})
  await view.webContents.executeJavaScript(mod.buildSidebarEntryScript()).catch(() => {})
  await new Promise((r) => setTimeout(r, 900))

  const data = await view.webContents.executeJavaScript(PROBE)
  const outFile = path.join(__dirname, 'out', 'sidebar-footer.json')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2))

  console.log('\n========== 侧边栏底部勘察 ==========')
  console.log('侧边栏列   :', JSON.stringify(data.sidebarCol))
  console.log('footArea   :', JSON.stringify(data.footArea && data.footArea.rect))
  console.log('\n-- 底部按钮（button/role=button/a）--')
  for (const b of data.footerButtons) console.log(' ', JSON.stringify(b))
  console.log('\n-- data-slot 锚点 --')
  for (const s of data.slots) console.log(' ', JSON.stringify(s))
  console.log('\n-- 底部叶子文本 --')
  for (const t of data.leafTexts) console.log(' ', JSON.stringify(t))
  console.log('\n完整结构见:', outFile)

  try {
    const shot = await view.webContents.capturePage({ x: 0, y: 560, width: 300, height: 340 })
    const f = path.join(app.getPath('temp'), 'sidebar-footer.png')
    fs.writeFileSync(f, shot.toPNG())
    console.log('SHOT=' + f)
  } catch { /* noop */ }

  try { child.kill() } catch { /* noop */ }
  app.exit(0)
})
