/**
 * 验证：会话头部让位 CSS（buildTopDragRegionCss 内的 overlay 安全区规则）是否真的
 * 让右上角图标按钮脱离原生窗口按钮簇。
 *
 * 判据：
 *   ① 应用后，header 内所有可见元素与按钮簇 `x∈[W-138,W], y∈[0,36]` 的交集面积为 0
 *   ② 应用前确实存在重叠（证明用例有鉴别力，不是假通过）
 *   ③ header 下移后仍未超出视口、且后续内容（选项卡/会话视图）没被压坏
 *   ④ `header` 选择器在各视图下命中数可控（不误伤其他 header）
 *   ⑤ 多个窗口宽度都成立
 */
const { app, BrowserWindow, Menu, WebContentsView } = require('electron')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')
const OVERLAY_H = 36
const CLUSTER_W = 138
const WIDTHS = [1440, 1280, 1200]

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label, detail !== undefined ? ' — ' + JSON.stringify(detail) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadEntryModule() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `hdr-verify-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error'
  })
  return require(out)
}

/** 测：header 相关元素与按钮簇的交集（返回最大交集面积与明细）
 *
 * 测量口径（两条关键修正，都来自实测踩坑）：
 * ① **文字用 Range 字形矩形**，不用元素盒子。列表项/容器常是「宽盒子 + 左对齐短文字」，
 *    用 element.getBoundingClientRect 会把大片空白算成交集 → 假阳性。
 * ② **必须按祖先 overflow 裁剪**。Range/元素矩形都是布局盒，不反映被 overflow:hidden
 *    裁掉的部分。实测有一条 2150px 宽的单行文字（远超 1440 视口），不裁剪就会被算成
 *    「压在按钮下 2484px²」，而它其实早被滚动容器裁掉了 → 假阳性。
 */
const MEASURE = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) } }
  const short = (el) => el.tagName + '.' + String(el.className || '').split(/\\s+/).filter(Boolean).map((s) => s.replace(/_[0-9a-z]{5,}_[0-9a-z]+/gi, '')).slice(0, 2).join('.')
  const W = window.innerWidth, H = window.innerHeight
  const cluster = { l: W - ${CLUSTER_W}, r: W, t: 0, b: ${OVERLAY_H} }

  /** 可见裁剪矩形：视口 ∩ 所有 overflow 非 visible 的祖先盒子 */
  const clipOf = (el) => {
    let l = 0, t = 0, r = W, b = H
    let e = el
    while (e && e !== document.documentElement) {
      const c = getComputedStyle(e)
      const ox = c.overflowX, oy = c.overflowY
      if (/hidden|clip|auto|scroll/.test(ox) || /hidden|clip|auto|scroll/.test(oy)) {
        const cr = e.getBoundingClientRect()
        if (/hidden|clip|auto|scroll/.test(ox)) { l = Math.max(l, cr.left); r = Math.min(r, cr.right) }
        if (/hidden|clip|auto|scroll/.test(oy)) { t = Math.max(t, cr.top); b = Math.min(b, cr.bottom) }
      }
      e = e.parentElement
    }
    return { l, t, r, b }
  }

  /** 把矩形先与祖先裁剪区求交，再与按钮簇求交 —— 得到「真实可见的遮挡」 */
  const visibleOverlap = (rect, clip) => {
    const vl = Math.max(rect.left, clip.l), vr = Math.min(rect.right, clip.r)
    const vt = Math.max(rect.top, clip.t), vb = Math.min(rect.bottom, clip.b)
    if (vr <= vl || vb <= vt) return { area: 0, ox: 0, oy: 0, clipped: true }
    const ox = Math.max(0, Math.min(vr, cluster.r) - Math.max(vl, cluster.l))
    const oy = Math.max(0, Math.min(vb, cluster.b) - Math.max(vt, cluster.t))
    return { area: Math.round(ox * oy), ox: Math.round(ox), oy: Math.round(oy), clipped: false }
  }

  const hdrs = [...document.querySelectorAll('header')]
  const hits = []

  // (a) 文字：Range 字形矩形 ∩ 祖先裁剪
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let tn
  while ((tn = walker.nextNode())) {
    if (!tn.nodeValue || !tn.nodeValue.trim()) continue
    const el = tn.parentElement
    if (!el) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue
    const range = document.createRange()
    range.selectNodeContents(tn)
    let clip = null
    for (const rr of range.getClientRects()) {
      if (rr.width < 1 || rr.height < 1) continue
      if (rr.top > ${OVERLAY_H} || rr.bottom < 0) continue
      if (rr.right < cluster.l) continue
      if (!clip) clip = clipOf(el)
      const o = visibleOverlap(rr, clip)
      if (o.area <= 0) continue
      hits.push({ kind: 'text', sel: short(el), rect: { t: Math.round(rr.top), b: Math.round(rr.bottom), l: Math.round(rr.left), r: Math.round(rr.right), h: Math.round(rr.height), w: Math.round(rr.width) }, text: tn.nodeValue.trim().slice(0, 36), area: o.area, ox: o.ox, oy: o.oy })
    }
  }

  // (b) 控件：带背景/边框、尺寸像按钮，同样按祖先裁剪
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || r.width > 400 || r.height > 80) continue
    if (r.top > ${OVERLAY_H} || r.bottom < 0) continue
    if (r.right < cluster.l) continue
    const c = getComputedStyle(el)
    const hasBg = c.backgroundColor !== 'rgba(0, 0, 0, 0)'
    const hasBorder = parseFloat(c.borderTopWidth) > 0 || parseFloat(c.borderLeftWidth) > 0 || parseFloat(c.borderRightWidth) > 0
    if (!hasBg && !hasBorder) continue
    if (el.children.length > 2) continue
    const o = visibleOverlap(r, clipOf(el))
    if (o.area <= 0) continue
    hits.push({ kind: 'ctrl', sel: short(el), rect: R(el), text: (el.textContent || '').trim().slice(0, 36), area: o.area, ox: o.ox, oy: o.oy })
  }
  hits.sort((a, b) => b.area - a.area)

  const tabs = document.querySelector('[class*="tabs"]')
  const titleRow = document.querySelector('[class*="titleRow"]')
  return {
    W,
    cluster,
    headerCount: hdrs.length,
    titleRow: titleRow ? R(titleRow) : null,
    headerRect: hdrs[0] ? R(hdrs[0]) : null,
    tabs: tabs ? R(tabs) : null,
    hitCount: hits.length,
    textHitCount: hits.filter((h) => h.kind === 'text').length,
    hits: hits.slice(0, 8),
    maxOverlap: hits.length ? hits[0].area : 0,
    scrollH: document.documentElement.scrollHeight,
    innerH: H
  }
})()`

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const mod = loadEntryModule()

  const log = path.join(app.getPath('temp'), 'verify-hdr-offset.log')
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

  const H = 854
  const win = new BrowserWindow({
    show: true, width: WIDTHS[0], height: H, x: 40, y: 40,
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
  await sleep(9000)

  /**
   * 打开一个真实会话，并**等到会话头真的渲染出来**（header 高度 > 0 且 titleRow 存在）。
   * 为什么必须等：空态/未选中会话时 DSH 不渲染会话头，此时「无重叠」是**空过**
   * （vacuous pass）——第一版脚本就因此假通过。这里轮询确认，拿不到就直接判失败并报诊断。
   *
   * 定位要点（实测踩坑）：`[class*="sessionRow"]` 会把**工作区分组行**（如 "gge2"）也算进来，
   * 点中分组只会折叠/展开、不会打开会话，会话头永远不出现。故这里逐个候选「点击 → 校验
   * header 是否出现」，失败就试下一个，而不是点一次就赌它命中。用 React fiber 读取的
   * node.id 优先（真实会话才有），分组行拿不到 id 自然被跳过。
   */
  async function ensureConversationHeader() {
    // 收集候选：优先带 React fiber node.id 的真实会话行
    const candidates = await view.webContents.executeJavaScript(`(() => {
      const readId = (el) => {
        const k = el && Object.keys(el).find((x) => x.startsWith('__reactFiber'))
        if (!k) return null
        let f = el[k]
        for (let i = 0; i < 8 && f; i++) {
          const p = f.memoizedProps
          if (p && p.node && typeof p.node.id === 'string' && p.node.id) return p.node.id
          f = f.return
        }
        return null
      }
      const rows = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')]
      const out = []
      for (const r of rows) {
        const t = (r.textContent || '').trim()
        if (!t || t.length > 300) continue
        const id = readId(r)
        out.push({ hasId: !!id, text: t.slice(0, 30) })
      }
      return out
    })()`)
    console.log(`  候选行 ${candidates.length} 个，其中带会话 id 的 ${candidates.filter((c) => c.hasId).length} 个`)

    for (let attempt = 0; attempt < 10; attempt++) {
      // 每次点一个候选（按索引推进，避免总点同一个分组行）
      const clicked = await view.webContents.executeJavaScript(`(() => {
        const readId = (el) => {
          const k = el && Object.keys(el).find((x) => x.startsWith('__reactFiber'))
          if (!k) return null
          let f = el[k]
          for (let i = 0; i < 8 && f; i++) {
            const p = f.memoizedProps
            if (p && p.node && typeof p.node.id === 'string' && p.node.id) return p.node.id
            f = f.return
          }
          return null
        }
        const rows = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')]
        // 只挑带 node.id 的真实会话行（工作区分组行会被排除）
        const real = rows.filter((r) => readId(r))
        const pool = real.length ? real : rows
        const idx = ${attempt} % Math.max(1, pool.length)
        const el = pool[idx]
        if (!el) return null
        const t = (el.textContent || '').trim()
        el.click()
        return { text: t.slice(0, 30), usedId: !!readId(el), poolSize: pool.length, idx }
      })()`)
      await sleep(2200)
      const st = await view.webContents.executeJavaScript(`(() => {
        const h = document.querySelector('header')
        const tr = document.querySelector('[class*="titleRow"]')
        const hr = h ? h.getBoundingClientRect() : null
        return { headerH: hr ? Math.round(hr.height) : 0, hasTitleRow: !!tr }
      })()`)
      console.log(`  [会话头就绪检查 ${attempt + 1}] header=${st.headerH}px titleRow=${st.hasTitleRow} 点击=${JSON.stringify(clicked)}`)
      if (st.headerH > 0 && st.hasTitleRow) return { ...st, clicked }
      // 点中的是分组行 → 再点一次展开它，下一轮换下一个候选
      if (attempt === 3) {
        await view.webContents.executeJavaScript(`(() => {
          for (const el of document.querySelectorAll('[role="button"], [class*="expand"], [class*="sessionRow"]')) {
            const t = (el.textContent || '').trim()
            if (t && /展开|其余\\s*\\d+\\s*个会话|show more|expand/i.test(t)) { el.click(); return true }
          }
          return false
        })()`)
        await sleep(1200)
      }
    }
    return null
  }

  const ctx = view.webContents

  /**
   * 像素真相：capturePage 抓「按钮簇区域里页面实际画出的内容」。
   * 为什么必须用像素而不是 DOM 几何：元素盒与 Range 矩形都是**布局盒**——既不反映祖先
   * overflow 裁剪、也不代表真的绘制了像素。实测踩坑：一条 2150px 宽（远超 1440 视口）
   * 的单行文字被几何法算成「压在按钮下 2484px²」，其实早被滚动容器裁掉。
   * 判定口径：该区域内除「众数背景色」以外的像素即被画出来的内容。
   * 说明：capturePage 只含 WebContents 自身像素、不含系统画的原生按钮，正合本用途。
   */
  async function clusterContentPixels() {
    const [vw] = win.getContentSize()
    const img = await ctx.capturePage({
      x: Math.max(0, vw - CLUSTER_W), y: 0, width: CLUSTER_W, height: OVERLAY_H
    })
    const size = img.getSize()
    const bmp = img.toBitmap()
    const tally = new Map()
    let total = 0
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        // 只统计左侧 70%：右侧留给不同机器上原生按钮画笔的差异
        if (x > size.width * 0.7) continue
        const i = (y * size.width + x) * 4
        const key = `${bmp[i + 2]},${bmp[i + 1]},${bmp[i]}`
        tally.set(key, (tally.get(key) || 0) + 1)
        total++
      }
    }
    let bg = null
    let bgN = 0
    for (const [k, v] of tally) if (v > bgN) { bgN = v; bg = k }
    const content = total - bgN
    // 内容占比 > 1% 视为「该区域确实画了东西」（抗抗锯齿噪点）
    return { bg, bgPct: total ? (bgN / total) * 100 : 0, contentPx: content, totalPx: total, contentPct: total ? (content / total) * 100 : 0 }
  }

  console.log('\n准备真实会话…')
  const ready = await ensureConversationHeader()
  console.log('会话头就绪 =', JSON.stringify(ready))
  assert(!!ready, '会话头已渲染（否则「无重叠」是空过，不能算通过）', ready)

  console.log('\n=========== 修复前（基线：应存在重叠）===========')
  const before = await ctx.executeJavaScript(MEASURE)
  const beforePx = await clusterContentPixels()
  console.log(`  宽度 ${before.W} | header 数=${before.headerCount} | 几何相交=${before.hitCount}（文字 ${before.textHitCount}）| 几何最大=${before.maxOverlap}px²`)
  console.log(`  像素：按钮簇内非背景内容 = ${beforePx.contentPx}px（${beforePx.contentPct.toFixed(1)}%），背景 ${beforePx.bg}`)
  console.log(`  titleRow=${JSON.stringify(before.titleRow)} header=${JSON.stringify(before.headerRect)}`)
  for (const h of before.hits) console.log(`    ⚠ [${h.kind}] ${h.sel} ${JSON.stringify(h.rect)} ${h.ox}x${h.oy}=${h.area}px² "${h.text}"`)

  // 应用让位 CSS（与生产同路径：insertCSS user origin）
  const text = mod.buildTopDragRegionCss(OVERLAY_H)
  assert(/#|header/.test(text) && text.includes('padding-top'), 'buildTopDragRegionCss 含 header 让位规则', text.slice(0, 120))
  await ctx.insertCSS(text, { cssOrigin: 'user' })
  await sleep(900)

  console.log('\n=========== 修复后（逐宽度）===========')
  const afterPx = []
  for (const w of WIDTHS) {
    win.setContentSize(w, H)
    await sleep(400)
    ;[cw, ch] = win.getContentSize()
    view.setBounds({ x: 0, y: 0, width: cw, height: ch })
    await sleep(900)
    const a = await ctx.executeJavaScript(MEASURE)
    const px = await clusterContentPixels()
    afterPx.push({ w: a.W, ...px })
    console.log(`\n----- 宽度 ${a.W} -----`)
    console.log(`  header 数=${a.headerCount} rect=${JSON.stringify(a.headerRect)}`)
    console.log(`  titleRow=${JSON.stringify(a.titleRow)}`)
    console.log(`  tabs=${JSON.stringify(a.tabs)}`)
    console.log(`  几何相交=${a.hitCount}（文字 ${a.textHitCount}）几何最大=${a.maxOverlap}px²`)
    console.log(`  像素：按钮簇内非背景内容 = ${px.contentPx}px（${px.contentPct.toFixed(1)}%），背景 ${px.bg}`)
    for (const h of a.hits) console.log(`    ⚠ [${h.kind}] ${h.sel} ${JSON.stringify(h.rect)} ${h.ox}x${h.oy}=${h.area}px² "${h.text}"`)

    // 非空过门禁：必须确认会话头真的在，否则「零重叠」毫无意义
    assert(a.headerRect && a.headerRect.h > 0 && a.titleRow, `[宽 ${a.W}] 会话头确实渲染（非空过）`, { header: a.headerRect, titleRow: a.titleRow })
    // 权威判据：像素级——按钮簇区域只应有纯背景，没有页面内容被画在那里
    assert(px.contentPct <= 1, `[宽 ${a.W}] 按钮簇区域无页面内容（像素非背景占比 ${px.contentPct.toFixed(2)}% ≤ 1%）`, px)
    assert(a.headerCount === 1, `[宽 ${a.W}] header 选择器只命中 1 个（不误伤）`, a.headerCount)
    // 标题行必须完全落在按钮带下方
    assert(a.titleRow && a.titleRow.t >= OVERLAY_H, `[宽 ${a.W}] 标题行已移到按钮带下方（top=${a.titleRow && a.titleRow.t} ≥ ${OVERLAY_H}）`, a.titleRow)
    // 内容没被压坏：滚动高度不超视口
    assert(a.scrollH <= a.innerH + 2, `[宽 ${a.W}] 页面未被撑出滚动条（scrollH=${a.scrollH} ≤ innerH=${a.innerH}+2）`, { scrollH: a.scrollH, innerH: a.innerH })
    // 选项卡仍紧随标题行之后，顺序正常
    assert(a.tabs && a.titleRow && a.tabs.t >= a.titleRow.b, `[宽 ${a.W}] 选项卡仍在标题行下方（顺序未乱）`, { titleRowBottom: a.titleRow && a.titleRow.b, tabsTop: a.tabs && a.tabs.t })
  }

  // 基线鉴别力：修复前，按钮簇区域像素上确实有内容（否则用例无鉴别力）
  assert(beforePx.contentPct > 1, `修复前按钮簇区域确实有内容像素（用例有鉴别力，实测 ${beforePx.contentPct.toFixed(1)}%）`, beforePx)
  assert(before.maxOverlap > 0, `修复前几何也测到重叠（实测 ${before.maxOverlap}px²）`, before.hits.slice(0, 3))
  assert(before.titleRow && before.titleRow.t < OVERLAY_H, '修复前标题行确实侵入按钮带', before.titleRow)

  // 视觉取证
  try {
    const b = win.getBounds()
    const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${b.width}, 130)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${b.x}, ${b.y}, 0, 0, $bmp.Size)
$bmp.Save((Join-Path $env:TEMP 'verify-hdr-offset.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output 'ok'
`
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' })
    console.log('\nSHOT=' + path.join(os.tmpdir(), 'verify-hdr-offset.png'))
  } catch { /* noop */ }

  try { child.kill() } catch { /* noop */ }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  app.exit(failed === 0 ? 0 : 1)
})
