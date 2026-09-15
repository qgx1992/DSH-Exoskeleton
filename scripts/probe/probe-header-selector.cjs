/**
 * 选择器勘察：为「会话头部整行下移 overlay 高度」找一个跨版本稳定的锚点。
 *
 * 动机：DSH 用 CSS module，类名带 hash（如 wSkVaW_header），直接写死不可依赖。
 * 本脚本枚举会话头部及其祖先的**稳定标记**（标签名 / data-* / role / 结构位），
 * 并实测每个候选选择器命中几个元素、是否只命中目标头部。
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

const PROBE = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) } }
  const attrsOf = (el) => {
    const a = {}
    for (const at of el.attributes) a[at.name] = at.value.length > 46 ? at.value.slice(0, 46) + '…' : at.value
    return a
  }
  const out = { roots: [], header: null, candidates: [] }

  // 从 titleRow 向上回溯，记录每一层的稳定信息
  const titleRow = document.querySelector('[class*="titleRow"]')
  if (!titleRow) return { error: 'no titleRow' }
  out.header = { tag: titleRow.tagName, attrs: attrsOf(titleRow), rect: R(titleRow) }

  const chain = []
  let el = titleRow
  for (let i = 0; el && i < 8; i++, el = el.parentElement) {
    chain.push({ depth: i, tag: el.tagName, attrs: attrsOf(el), rect: R(el), childCount: el.children.length })
  }
  out.roots = chain

  // 找 header 元素（titleRow 的最近 header 祖先）
  let hdr = titleRow.closest('header')
  out.headerEl = hdr ? { tag: hdr.tagName, attrs: attrsOf(hdr), rect: R(hdr), childCount: hdr.children.length,
    kids: [...hdr.children].map((k) => ({ tag: k.tagName, attrs: attrsOf(k), rect: R(k) })) } : null

  // 候选选择器命中测试（数量 + 首个命中是否就是目标头部）
  const sels = [
    'header',
    '[class*="header"]',
    'header[class*="header"]',
    '[class*="titleRow"]',
    '[class*="headerUtilities"]',
    '[class*="headerCorner"]',
    '[class*="centerCol"] > * > header',
    'main header',
    '[role="banner"]'
  ]
  for (const s of sels) {
    let els = []
    try { els = [...document.querySelectorAll(s)] } catch (e) { out.candidates.push({ sel: s, error: String(e) }); continue }
    const first = els[0]
    const firstIsTarget = !!(hdr && first === hdr)
    const firstRect = first ? R(first) : null
    const topCount = els.filter((e) => e.getBoundingClientRect().top < 100).length
    out.candidates.push({ sel: s, count: els.length, topCount, firstIsTarget, firstTag: first ? first.tagName : null, firstRect })
  }

  // 结构位：centerCol 的第一个子元素的第一个子元素是否就是 header
  const cc = document.querySelector('[class*="centerCol"]')
  out.centerColPath = null
  if (cc) {
    const path = []
    let cur = hdr
    while (cur && cur !== cc.parentElement) { path.unshift(cur.tagName + '[' + cur.children.length + ']'); cur = cur.parentElement }
    out.centerColPath = { centerCol: attrsOf(cc), pathFromHeaderUp: path }
  }
  return out
})()`

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const log = path.join(app.getPath('temp'), 'probe-sel.log')
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

  const win = new BrowserWindow({
    show: true, width: 1440, height: 854, x: 40, y: 40,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#151517', symbolColor: '#f9fafb', height: 36 }
  })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  const [cw, ch] = win.getContentSize()
  view.setBounds({ x: 0, y: 0, width: cw, height: ch })
  await view.webContents.loadURL(url)
  await new Promise((r) => setTimeout(r, 9000))
  const clicked = await view.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')]
    for (const r of rows) { const t = (r.textContent||'').trim(); if (t && t.length < 200 && !/展开|工作区|其余/.test(t)) { r.click(); return true } }
    return false
  })()`)
  console.log('点击会话 =', clicked)
  await new Promise((r) => setTimeout(r, 3500))

  const r = await view.webContents.executeJavaScript(PROBE)
  if (r.error) { console.error('探针失败:', r.error); app.exit(1); return }

  console.log('\n============ 会话头部元素 ============')
  console.log('titleRow:', JSON.stringify(r.header))
  if (r.headerEl) {
    console.log('\n<header> 元素:')
    console.log('  attrs =', JSON.stringify(r.headerEl.attrs))
    console.log('  rect  =', JSON.stringify(r.headerEl.rect), 'children =', r.headerEl.childCount)
    for (const k of r.headerEl.kids) {
      console.log(`    子 ${k.tag} ${JSON.stringify(k.attrs)} rect=${JSON.stringify(k.rect)}`)
    }
  } else {
    console.log('\n（未找到 <header> 祖先元素）')
  }

  console.log('\n============ 祖先链（titleRow 向上 8 层）============')
  for (const c of r.roots) {
    console.log(`  depth ${c.depth}: ${c.tag} children=${c.childCount} rect=${JSON.stringify(c.rect)}`)
    console.log(`      attrs = ${JSON.stringify(c.attrs)}`)
  }

  console.log('\n============ 候选选择器命中 ============')
  for (const c of r.candidates) {
    if (c.error) { console.log(`  ${c.sel}  → ERROR ${c.error}`); continue }
    console.log(`  ${c.sel}`)
    console.log(`     命中 ${c.count} 个（其中 top<100 的 ${c.topCount} 个）| 首个是目标头部=${c.firstIsTarget} | 首 ${c.firstTag} ${JSON.stringify(c.firstRect)}`)
  }

  if (r.centerColPath) {
    console.log('\n============ 结构位 ============')
    console.log('  centerCol attrs =', JSON.stringify(r.centerColPath.centerCol))
    console.log('  从 header 向上:', r.centerColPath.pathFromHeaderUp.join('  ←  '))
  }

  try { child.kill() } catch { /* noop */ }
  app.exit(0)
})
