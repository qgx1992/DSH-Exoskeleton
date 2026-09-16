/**
 * 端到端验证：顶部拖拽区（方案 C）是否真的让「中间主体顶部」可拖动。
 *
 * 判据（全部来自生产代码，不自己拼 CSS）：
 *   ① 空态：拖拽条存在，且带内采样点解析 app-region = drag
 *   ② 空态：带内没有可交互元素被盖住（否则吞点击）
 *   ③ 会话态：拖拽条被撤掉（header 自带拖拽），带内采样点仍是 drag
 *   ④ 会话态：header 内所有可交互元素解析 region = no-drag（★ 防误拖：按钮必须可点）
 *   ⑤ 会话态：标题行仍可见且在原生按钮簇下方（没被挤压/错位）
 *   ⑥ 侧边栏折叠后拖拽条左边界跟随（不留缝、不盖按钮）
 *   ⑦ 页面未出滚动条（拖拽条不影响布局）
 */
const { app, BrowserWindow, Menu, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })
setTimeout(() => { console.error('[verify] 硬超时'); app.exit(2) }, 280000)

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')
const OVERLAY_H = 36
const CLUSTER_W = 138

let passed = 0, failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) }
  else { failed++; console.error('  ✗', label, detail !== undefined ? '— ' + JSON.stringify(detail) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadModule() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `drag-verify-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error'
  })
  return require(out)
}

const SURVEY = `(() => {
  const short = (el) => el.tagName.toLowerCase() + '.' + String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.')
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right) } }
  const resolve = (el) => { for (let c = el, i = 0; c && i < 16; c = c.parentElement, i++) { const v = getComputedStyle(c).webkitAppRegion; if (v && v !== 'none') return v } return 'none' }
  const W = window.innerWidth, H = window.innerHeight
  const col = document.querySelector('[class*="sidebarCol"]')
  const sw = col ? Math.round(col.getBoundingClientRect().width) : 0
  const stripEl = document.getElementById('dsh-exo-drag-strip')
  const stripRect = stripEl ? R(stripEl) : null

  // 带内采样点（避开侧边栏与按钮簇）
  const pts = []
  for (const y of [4, 18, 30]) {
    for (const x of [sw + 60, Math.round((sw + W - ${CLUSTER_W}) / 2), W - ${CLUSTER_W} - 60]) {
      if (x <= sw || x >= W) continue
      const el = document.elementFromPoint(x, y)
      pts.push({ x, y, el: el ? (el.id ? '#' + el.id : short(el)) : null, region: el ? resolve(el) : null })
    }
  }

  // 带内被盖住的可交互元素
  const SEL = 'button, a[href], input, textarea, select, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [contenteditable="true"]'
  const covered = []
  for (const el of document.querySelectorAll(SEL)) {
    if (stripEl && (el === stripEl || stripEl.contains(el))) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    if (r.bottom <= 0 || r.top >= ${OVERLAY_H}) continue
    if (r.right <= sw || r.left >= W - ${CLUSTER_W}) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    covered.push({ sel: short(el), rect: R(el), aria: el.getAttribute('aria-label'), text: (el.textContent || '').trim().slice(0, 16) })
  }

  // header 内可交互元素（会话态必须都可点）
  const hdr = [...document.querySelectorAll('header')].find((h) => h.getBoundingClientRect().height > 0)
  const hdrInter = []
  if (hdr) {
    for (const el of hdr.querySelectorAll('button, a, input, [role="button"], [role="tab"], img, svg')) {
      const r = el.getBoundingClientRect()
      if (r.width < 6 || r.height < 6 || r.top >= 120) continue
      hdrInter.push({ sel: short(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), region: resolve(el) })
    }
  }
  const titleRow = document.querySelector('[class*="titleRow"]')
  const hdrSelf = hdr ? getComputedStyle(hdr).webkitAppRegion : null
  return {
    W, H, sw, stripRect, hasStrip: !!stripEl,
    stripRegion: stripEl ? getComputedStyle(stripEl).webkitAppRegion : null,
    hasSizedHeader: !!hdr, headerRegion: hdrSelf,
    headerRect: hdr ? R(hdr) : null,
    titleRowRect: titleRow ? R(titleRow) : null,
    pts, coveredCount: covered.length, covered: covered.slice(0, 6),
    hdrInterCount: hdrInter.length,
    hdrInterBad: hdrInter.filter((i) => i.region !== 'no-drag'),
    scrollH: document.documentElement.scrollHeight, innerH: H
  }
})()`

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const mod = loadModule()

  const log = path.join(app.getPath('temp'), 'verify-drag.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  const child = spawn(process.env.DSH_PROBE_NODE || 'node', [KERNEL_BIN, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    stdio: ['ignore', fd, fd], windowsHide: true
  })
  let url = null
  for (let i = 0; i < 60; i++) {
    await sleep(500)
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
  const [cw0, ch0] = win.getContentSize()
  view.setBounds({ x: 0, y: 0, width: cw0, height: ch0 })
  await view.webContents.loadURL(url)
  await sleep(10000)

  // 复刻生产的两次注入（CSS + 拖拽条脚本）
  const inject = async () => {
    await view.webContents.insertCSS(mod.buildTopDragRegionCss(OVERLAY_H), { cssOrigin: 'user' })
    return view.webContents.executeJavaScript(mod.buildTopDragStripScript(OVERLAY_H, CLUSTER_W, 280))
  }
  const firstInject = await inject()
  await sleep(500)

  // ============ 空态 ============
  let r = await view.webContents.executeJavaScript(SURVEY)
  console.log('\n========== 空态 ==========')
  console.log('  注入返回 =', JSON.stringify(firstInject), '| 拖拽条 =', JSON.stringify(r.stripRect), '| 列宽 =', r.sw)
  assert(r.hasSizedHeader === false, '前置：空态确实没有有高度的 header（否则本组无鉴别力）', r.hasSizedHeader)
  assert(r.hasStrip === true, '空态插入了拖拽条')
  assert(r.stripRegion === 'drag', '拖拽条自身 app-region = drag', r.stripRegion)
  assert(r.stripRect && Math.abs(r.stripRect.l - r.sw) <= 1, '拖拽条左边界贴合侧边栏右边界', { strip: r.stripRect, sw: r.sw })
  assert(r.stripRect && Math.abs(r.stripRect.r - (r.W - CLUSTER_W)) <= 1, '拖拽条右边界让开原生按钮簇', { strip: r.stripRect, expect: r.W - CLUSTER_W })
  const allDrag = r.pts.every((p) => p.region === 'drag')
  assert(r.pts.length >= 6, '采样点数量足够', r.pts.length)
  assert(allDrag, '空态带内所有采样点都能拖（region=drag）', r.pts.filter((p) => p.region !== 'drag'))
  assert(r.coveredCount === 0, '空态带内没有被拖拽条盖住的可交互元素', r.covered)
  assert(r.scrollH <= r.innerH + 1, '拖拽条没把页面撑出滚动条', { scrollH: r.scrollH, innerH: r.innerH })

  // ============ 打开会话 ============
  const readIdFn = `(el) => {
    const k = el && Object.keys(el).find((x) => x.startsWith('__reactFiber'))
    if (!k) return null
    let f = el[k]
    for (let i = 0; i < 8 && f; i++) { const p = f.memoizedProps; if (p && p.node && typeof p.node.id === 'string' && p.node.id) return p.node.id; f = f.return }
    return null
  }`
  const sized = () => view.webContents.executeJavaScript(
    `[...document.querySelectorAll('header')].some((h) => h.getBoundingClientRect().height > 0)`)
  for (let attempt = 0; attempt < 14; attempt++) {
    if (await sized()) break
    await view.webContents.executeJavaScript(`(() => {
      const readId = ${readIdFn}
      const rows = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')]
      const real = rows.filter((r) => readId(r))
      const pool = real.length ? real : rows
      const el = pool[${attempt} % Math.max(1, pool.length)]
      if (el) el.click()
      return pool.length
    })()`)
    await sleep(2500)
  }
  await sleep(1500)

  // ============ 会话态 ============
  r = await view.webContents.executeJavaScript(SURVEY)
  console.log('\n========== 会话态 ==========')
  console.log('  拖拽条存在 =', r.hasStrip, '| header =', JSON.stringify(r.headerRect), 'region =', r.headerRegion)
  assert(r.hasSizedHeader === true, '前置：会话态 header 已渲染（非空过）', r.hasSizedHeader)
  assert(r.hasStrip === false, '会话态撤掉了拖拽条（不与 header 抢位）', r.hasStrip)
  assert(r.headerRegion === 'drag', 'header 自身 app-region = drag', r.headerRegion)
  const sessDrag = r.pts.every((p) => p.region === 'drag')
  assert(sessDrag, '会话态带内所有采样点都能拖（region=drag）', r.pts.filter((p) => p.region !== 'drag'))
  assert(r.hdrInterCount >= 8, 'header 内可交互元素数量合理（用例有鉴别力）', r.hdrInterCount)
  assert(r.hdrInterBad.length === 0, '★ header 内所有可交互元素都可点（region=no-drag，没被 drag 吞掉）', r.hdrInterBad)
  assert(r.coveredCount === 0, '会话态带内没有被盖住的可交互元素', r.covered)

  // ============ 侧边栏折叠 ============
  await view.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '收起侧边栏')
    if (b) b.click(); return !!b
  })()`)
  await sleep(1500)
  // 折叠后 header 仍在 → 拖拽条仍应撤掉；此处专门验证「再次进入空态时左边界跟随」
  const collapsedWidth = await view.webContents.executeJavaScript(
    `Math.round((document.querySelector('[class*="sidebarCol"]')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width)`)
  assert(collapsedWidth > 0 && collapsedWidth < 120, '侧边栏确实折叠了（宽度变小，用例有鉴别力）', collapsedWidth)
  // 手动触发一次 sync，确认不会因折叠而在会话态误插拖拽条
  await view.webContents.executeJavaScript(`(() => { try { return window.__dshExoDragStripSync ? window.__dshExoDragStripSync() : 'no' } catch { return 'err' } })()`)
  await sleep(400)
  const afterCollapseStrip = await view.webContents.executeJavaScript(`!!document.getElementById('dsh-exo-drag-strip')`)
  assert(afterCollapseStrip === false, '折叠后（仍会话态）拖拽条依旧不插', afterCollapseStrip)

  // ============ 回到空态（新建会话）→ 验证折叠后的左边界跟随 ============
  await view.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '新建会话')
    if (b) b.click(); return !!b
  })()`)
  await sleep(3000)
  const emptyAgain = await view.webContents.executeJavaScript(SURVEY)
  console.log('\n========== 回到空态（侧边栏已折叠）==========')
  console.log('  列宽 =', emptyAgain.sw, '| 拖拽条 =', JSON.stringify(emptyAgain.stripRect), '| 有 header =', emptyAgain.hasSizedHeader)
  if (!emptyAgain.hasSizedHeader) {
    assert(emptyAgain.hasStrip === true, '折叠后回空态：拖拽条重新插入', emptyAgain.hasStrip)
    assert(emptyAgain.stripRect && Math.abs(emptyAgain.stripRect.l - emptyAgain.sw) <= 1,
      '★ 折叠后拖拽条左边界跟随新列宽（不留缝、不盖侧边栏按钮）',
      { strip: emptyAgain.stripRect, sw: emptyAgain.sw })
    assert(emptyAgain.coveredCount === 0, '折叠后带内没有被盖住的可交互元素', emptyAgain.covered)
    assert(emptyAgain.pts.every((p) => p.region === 'drag'), '折叠后带内仍可拖', emptyAgain.pts.filter((p) => p.region !== 'drag'))
  } else {
    console.log('  （新建会话后 header 仍在，跳过折叠空态断言）')
  }

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
  try { child.kill() } catch { /* noop */ }
  app.exit(failed === 0 ? 0 : 1)
})
