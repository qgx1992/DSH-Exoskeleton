/**
 * 定论取证：会话头部那一行到底有没有元素被右上角原生按钮遮挡，以及从哪个宽度开始。
 *
 * 前一个脚本的缺陷：resize 后没同步 WebContentsView 的 bounds，innerWidth 始终 1580，
 * 多宽度对比形同虚设。本脚本每次 resize 后都重设 view bounds（等价于生产的 layoutView）。
 *
 * 同时验证 Electron WCO 是否把 env(titlebar-area-*) 下发给 WebContentsView 子视图——
 * 这决定修法能不能用官方变量自适应，还是必须写死像素。
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
const OVERLAY_H = 36
const CLUSTER_W = 138
const WIDTHS = [1580, 1500, 1400, 1250, 1100, 1000]

const PROBE = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) } }
  const short = (el) => el.tagName + '.' + String(el.className || '').split(/\\s+/).filter(Boolean).map((s) => s.replace(/_[0-9a-z]{5,}_[0-9a-z]+/gi, '')).slice(0, 2).join('.')

  // Electron WCO 是否下发给本视图？
  const d = document.createElement('div')
  d.style.cssText = 'position:absolute;visibility:hidden;top:env(titlebar-area-y,-1px);left:env(titlebar-area-x,-1px);width:env(titlebar-area-width,-1px);height:env(titlebar-area-height,-1px)'
  document.body.appendChild(d)
  const dc = getComputedStyle(d)
  const env = { x: dc.left, y: dc.top, w: dc.width, h: dc.height }
  d.remove()

  const W = window.innerWidth
  const cluster = { l: W - ${CLUSTER_W}, r: W, t: 0, b: ${OVERLAY_H} }
  const inter = (r) => {
    const ox = Math.max(0, Math.min(r.right, cluster.r) - Math.max(r.left, cluster.l))
    const oy = Math.max(0, Math.min(r.bottom, cluster.b) - Math.max(r.top, cluster.t))
    return { ox: Math.round(ox), oy: Math.round(oy), area: Math.round(ox * oy) }
  }

  // 所有与按钮簇相交、且「有可见内容」的元素（有文字 或 有背景/边框）
  const hits = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    if (r.top > ${OVERLAY_H} || r.bottom < 0) continue
    const i = inter(r)
    if (i.area <= 0) continue
    const c = getComputedStyle(el)
    const hasBg = c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'transparent'
    const hasBorder = c.borderTopWidth !== '0px' || c.borderLeftWidth !== '0px' || c.borderRightWidth !== '0px'
    const txt = (el.textContent || '').trim()
    if (!txt && !hasBg && !hasBorder) continue
    hits.push({ sel: short(el), rect: R(el), text: txt.slice(0, 40), overlap: i, hasBg, hasBorder })
  }
  hits.sort((a, b) => b.overlap.area - a.overlap.area)

  // 头部那一行 + 其直接子元素（看右端留白）
  const titleRow = document.querySelector('[class*="titleRow"]')
  const trInfo = titleRow ? { rect: R(titleRow), kids: [] } : null
  if (titleRow) {
    for (const k of titleRow.children) trInfo.kids.push({ sel: short(k), rect: R(k), text: (k.textContent || '').trim().slice(0, 40) })
  }
  // 头部行内最靠右的叶子
  let maxRight = -1, mrInfo = null
  if (titleRow) {
    for (const el of titleRow.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width < 6 || r.height < 6) continue
      if ((el.textContent || '').trim() || getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)') {
        if (r.right > maxRight) { maxRight = r.right; mrInfo = { sel: short(el), rect: R(el), text: (el.textContent || '').trim().slice(0, 30) } }
      }
    }
  }
  return { W, env, cluster, hitCount: hits.length, hits: hits.slice(0, 10), titleRow: trInfo, maxRightLeaf: mrInfo, rightGap: mrInfo ? Math.round(W - mrInfo.rect.r) : null }
})()`

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const log = path.join(app.getPath('temp'), 'probe-occl.log')
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

  const H = 854
  const win = new BrowserWindow({
    show: true, width: 1580, height: H, x: 40, y: 40,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#151517', symbolColor: '#f9fafb', height: OVERLAY_H }
  })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  let [cw, ch] = win.getContentSize()
  view.setBounds({ x: 0, y: 0, width: cw, height: ch })
  await view.webContents.loadURL(url)
  await new Promise((r) => setTimeout(r, 9000))

  const clicked = await view.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')]
    for (const r of rows) {
      const t = (r.textContent || '').trim()
      if (t && t.length < 200 && !/展开|工作区|其余/.test(t)) { r.click(); return t.slice(0, 40) }
    }
    return null
  })()`)
  console.log('点击会话 =', JSON.stringify(clicked))
  await new Promise((r) => setTimeout(r, 3500))

  const shots = []
  console.log('\n=========== 逐宽度：与按钮簇相交的可见元素 ===========')
  for (const w of WIDTHS) {
    win.setContentSize(w, H)
    await new Promise((r) => setTimeout(r, 400))
    ;[cw, ch] = win.getContentSize()
    view.setBounds({ x: 0, y: 0, width: cw, height: ch })   // 等价生产的 layoutView
    await new Promise((r) => setTimeout(r, 900))

    const r = await view.webContents.executeJavaScript(PROBE)
    console.log(`\n----- 宽度 ${r.W}（按钮簇 x∈[${r.cluster.l},${r.cluster.r}] y∈[0,${r.cluster.b}]）-----`)
    console.log(`  env(titlebar-area-*) = ${JSON.stringify(r.env)}`)
    console.log(`  titleRow = ${r.titleRow ? JSON.stringify(r.titleRow.rect) : 'null'}`)
    if (r.titleRow) for (const k of r.titleRow.kids) console.log(`      子 ${k.sel} ${JSON.stringify(k.rect)} "${k.text}"`)
    console.log(`  头部最靠右叶子: ${r.maxRightLeaf ? r.maxRightLeaf.sel + ' right=' + r.maxRightLeaf.rect.r + ` "${r.maxRightLeaf.text}"` : 'null'}  → 距窗口右边 ${r.rightGap}px`)
    console.log(`  与簇相交的可见元素数 = ${r.hitCount}`)
    for (const h of r.hits) {
      console.log(`    ⚠ ${h.sel} rect=${JSON.stringify(h.rect)} 重叠=${h.overlap.ox}x${h.overlap.oy}=${h.overlap.area}px² bg=${h.hasBg} border=${h.hasBorder} text="${h.text}"`)
    }
    if (r.hitCount === 0) console.log('    （无）')

    // 视觉取证：抓右上角桌面像素（含原生按钮）
    try {
      const b = win.getBounds()
      const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${b.width}, 60)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${b.x}, ${b.y}, 0, 0, $bmp.Size)
$f = Join-Path $env:TEMP 'occl-${r.W}.png'
$bmp.Save($f, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $f
`
      const { execFileSync } = require('child_process')
      const f = execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' }).toString().trim()
      shots.push(f)
    } catch { /* noop */ }
  }

  console.log('\nSHOTS=' + JSON.stringify(shots))
  try { child.kill() } catch { /* noop */ }
  app.exit(0)
})
