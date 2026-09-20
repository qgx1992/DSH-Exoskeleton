/**
 * 端到端验证：侧边栏底部「一行 4 个小按钮」工具栏。
 *
 * 判据（全部来自生产代码，不自己拼 CSS/脚本）：
 *   ① 宽态（侧边栏展开）：footArea 里恰好 4 个按钮，同排（同一行 y 区间）、32×32
 *   ② 官方设置按钮被缩成小方钮，但仍带 aria-haspopup=dialog（点击链路未改）
 *   ③ 点击「网页版 DeepSeek」→ 桥收到 webpanel:toggle
 *   ④ 点击「管理面板」→ 桥收到 panel:open
 *   ⑤ 点击「折叠切换」→ 官方 dsh-ui-tools 按钮被触发（分组 aria-expanded 全部翻转）
 *   ⑥ 宽态下 dsh-ui-tools 的整行工具条已收进工具栏（不再独占 256×36 一行）
 *   ⑦ 收起侧边栏（56px rail）→ 只留设置按钮，其余隐藏，且不出现溢出/破版
 *   ⑧ 自愈：删掉壳注入的按钮后自动补回
 *   ⑨ 视觉取证：底部区截图
 *
 * 用法：npx electron scripts/probe/verify-sidebar-footer.cjs
 */
const { app, BrowserWindow, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })
setTimeout(() => { console.error('[verify] 硬超时'); app.exit(2) }, 280000)

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) }
  else { failed++; console.error('  ✗', label, detail !== undefined ? '— ' + JSON.stringify(detail) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadModule () {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `footer-verify-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'web-sidebar-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error'
  })
  return require(out)
}

/** 宽态工具栏采样 */
const SURVEY_WIDE = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) } }
  const short = (el) => el.tagName.toLowerCase() + '.' + String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.')
  const foot = document.querySelector('[class*="footArea"]')
  const footBox = foot ? foot.getBoundingClientRect() : null
  // 只算**几何上确实落在底部区内**的按钮：第三方插件（实测 dsh-cost-meter 的 cm-qguide
  // 提示卡）会把自己 position:fixed 的浮层也渲染在插槽内——DOM 上是 footArea 后代，
  // 但坐标在屏幕别处，不排除会被误计为底栏按钮（实测多出 4 个，坐标 y=18/33/111）。
  const inFoot = (b) => {
    const r = b.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || !footBox) return false
    return r.top >= footBox.top - 1 && r.bottom <= footBox.bottom + 1 &&
      r.left >= footBox.left - 1 && r.right <= footBox.right + 1
  }
  const cs = (el) => el ? getComputedStyle(el) : null
  const btns = [...document.querySelectorAll('[class*="footArea"] button')]
    .filter((b) => {
      const st = getComputedStyle(b)
      return st.display !== 'none' && st.visibility !== 'hidden' && inFoot(b)
    })
    .map((b) => ({ id: b.id || null, sel: short(b), aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), rect: R(b), haspopup: b.getAttribute('aria-haspopup'), disabled: b.getAttribute('data-disabled') }))
  const collapseBar = document.querySelector('.wc-collapse-bar')
  return {
    sidebarWidth: Math.round((document.querySelector('[class*="sidebarCol"]') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
    footRect: foot ? R(foot) : null,
    footRailAttr: foot ? foot.getAttribute('data-dsh-exo-rail') : null,
    footOverflowY: foot ? cs(foot).overflowY : null,
    footScrollable: foot ? foot.scrollHeight - foot.clientHeight : null,
    buttons: btns,
    collapseBarDisplay: collapseBar ? cs(collapseBar).display : 'missing',
    collapseBarRect: collapseBar ? R(collapseBar) : null,
    expandedStates: [...document.querySelectorAll('[data-slot="sidebar.workspaces"] [aria-expanded]')]
      .filter((el) => el.tagName !== 'BUTTON').map((el) => el.getAttribute('aria-expanded'))
  }
})()`

/** 窄态（rail）采样 */
const SURVEY_RAIL = `(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) } }
  const foot = document.querySelector('[class*="footArea"]')
  const footBox = foot ? foot.getBoundingClientRect() : null
  // 同宽态：排除第三方 fixed 浮层（DOM 上是 footArea 后代，但不在底栏坐标内）
  const inFoot = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || !footBox) return false
    return r.top >= footBox.top - 1 && r.bottom <= footBox.bottom + 1 &&
      r.left >= footBox.left - 1 && r.right <= footBox.right + 1
  }
  const visible = (el) => { const st = getComputedStyle(el); return st.display !== 'none' && st.visibility !== 'hidden' && inFoot(el) }
  return {
    sidebarWidth: Math.round((document.querySelector('[class*="sidebarCol"]') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
    footRect: foot ? R(foot) : null,
    footRailAttr: foot ? foot.getAttribute('data-dsh-exo-rail') : null,
    buttons: [...document.querySelectorAll('[class*="footArea"] button')].map((b) => ({ id: b.id || null, aria: b.getAttribute('aria-label'), visible: visible(b), rect: R(b) })),
    docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})()`

app.whenReady().then(async () => {
  const mod = loadModule()
  const log = path.join(app.getPath('temp'), 'dsh-footer-verify.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  // env 可继承：DSH_HOME 指向别的 profile 时（如本机 web profile 被外部改动临时损坏，
  // 用一份副本验证）不必改脚本。默认不设 = 用真实 ~/.dsh。
  const child = spawn('node', [KERNEL_BIN, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    stdio: ['ignore', fd, fd], windowsHide: true, env: process.env
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

  const win = new BrowserWindow({ show: true, width: 1440, height: 900, x: 40, y: 40 })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 })

  // 与生产同款的两步清理（否则本脚本跑多了必定假失败）：
  //  ① 本脚本每次起新内核（新 secret）都会新增一个 dsh-auth cookie，默认 session 共享、
  //     旧的不自动清 → 累积到请求头超 node:http 16KB 上限触发 431，插件 bundle 加载失败，
  //     页面就卡在「Failed to load plugins」（实测重现；生产代码有同样的清理，见 window-manager）。
  //  ② 旧缓存里的 index/bundle rev 可能已失效。
  const viewSession = view.webContents.session
  await viewSession.clearCache().catch(() => {})
  const cookies = await viewSession.cookies.get({ domain: '127.0.0.1' }).catch(() => [])
  const auth = cookies
    .filter((c) => typeof c.name === 'string' && c.name.startsWith('dsh-auth-'))
    .sort((a, b) => (b.expirationDate ?? 0) - (a.expirationDate ?? 0))
  for (const c of auth.slice(2)) {
    await viewSession.cookies.remove(`http://${c.domain}${c.path ?? '/'}`, c.name).catch(() => {})
  }
  console.log('清理陈旧 dsh-auth cookie:', Math.max(0, auth.length - 2), '个（共', auth.length, '）')

  const received = []
  view.webContents.on('ipc-message', (_e, channel, ...args) => {
    if (channel === 'dsh-exo') received.push(String(args[0]))
  })

  await view.webContents.loadURL(url)
  // 等页面真的把侧边栏渲染出来再注入。两件事都要处理：
  //  ① 启动竞态：内核刚监听时 client-modules 的 bundle 组合仍在变，早期页面会显示
  //     「Failed to load plugins」（实测固定 sleep 10s 不够，页面一直卡在该横幅）；
  //     生产代码有同款自愈（window-manager 的 scheduleDshViewHealthCheck：
  //     检测到横幅 → reloadIgnoringCache），验证脚本仿一份，否则测试环境不等于生产。
  //  ② 就绪判定不看固定时长，看侧边栏真的挂载了。最多约 3 分钟。
  let ready = false
  for (let i = 0; i < 180; i++) {
    await sleep(1000)
    if (i > 0 && i % 20 === 0) {
      // 每 20s 检查一次是否卡在插件加载失败横幅，是则清缓存重载
      const failed = await view.webContents.executeJavaScript(
        `/failed to load plugins/i.test(document.body ? document.body.innerText : '')`
      ).catch(() => false)
      if (failed) {
        console.log('检测到 Failed to load plugins，清缓存重载（第 ' + (i / 20) + ' 次）')
        try { view.webContents.reloadIgnoringCache() } catch { /* noop */ }
        continue
      }
    }
    ready = await view.webContents.executeJavaScript(
      `!!document.querySelector('[class*="sidebarCol"]') && !!document.querySelector('[class*="footArea"]')`
    ).catch(() => false)
    if (ready) break
  }
  console.log('侧边栏就绪:', ready)
  if (!ready) { console.error('页面未就绪，中止'); try { child.kill() } catch { /* noop */ }; app.exit(3); return }
  await sleep(1500)

  // 与生产同路径注入：拖拽区 CSS + 入口 + 底部工具栏
  await view.webContents.insertCSS(mod.buildTopDragRegionCss(36), { cssOrigin: 'user' }).catch(() => {})
  await view.webContents.executeJavaScript(mod.buildSidebarEntryScript())
  await view.webContents.executeJavaScript(mod.buildSidebarFooterScript())
  await sleep(900)
  // 折叠态判定依赖侧边栏宽度实测，与壳侧注入后的显式同步一致
  await view.webContents.executeJavaScript(`(() => { try { return window.__dshExoFootSync() } catch (e) { return 'err' } })()`)
  await sleep(400)

  const wide = await view.webContents.executeJavaScript(SURVEY_WIDE)
  console.log('\n===== 宽态采样 =====')
  console.log(JSON.stringify(wide, null, 1))

  const visible = wide.buttons
  const ids = visible.map((b) => b.id)
  assert(wide.sidebarWidth > 100, '①侧边栏处于展开态（宽度 > 100px）', wide.sidebarWidth)
  assert(visible.length === 4, '①可见按钮恰好 4 个', visible.length)

  // ── 自适应均分（真实内核 + 真实第三方插件共用插槽的环境下复核）──
  // 注：「宽度变化后间距跟随」在实机里没法验（DSH 侧栏宽度由 AppFrame 的 grid 轨道控制，
  // 写内联 style.width 不生效），该点由仿真契约测试覆盖（那里 footW 确实随 240/280/320 变）。
  const spacing = await view.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('.dsh-exo-foot-btn, [class*="triggerRow"] > button[class*="trigger"]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    const foot = document.querySelector('[class*="footArea"]')
    const fr = foot.getBoundingClientRect()
    const centers = btns.map((b) => { const r = b.getBoundingClientRect(); return (r.left + r.width / 2 - fr.left) / fr.width }).sort((a, b) => a - b)
    return { centers, gaps: centers.slice(1).map((c, i) => c - centers[i]), footW: Math.round(fr.width) }
  })()`)
  const centerError = (centers) => (centers.length !== 4 ? 1 : Math.max(...centers.map((c, i) => Math.abs(c - (2 * i + 1) / 8))))
  assert(centerError(spacing.centers) < 0.03, '⑨真实环境下 4 个按钮等距均分（中心 1/8·3/8·5/8·7/8）', { centers: spacing.centers.map((c) => c.toFixed(3)), footW: spacing.footW })
  assert(Math.max(...spacing.gaps) - Math.min(...spacing.gaps) < 0.03, '⑨真实环境下相邻按钮间距相等', spacing.gaps.map((g) => g.toFixed(3)))
  assert(spacing.centers.length === 4, '⑨均分采样到 4 个按钮', spacing.centers.length)
  assert(ids.includes('dsh-exo-webpanel-entry'), '①含「网页版 DeepSeek」按钮', ids)
  assert(ids.includes('dsh-exo-panel-entry'), '①含「管理面板」按钮', ids)
  assert(ids.includes('dsh-exo-collapse-toggle'), '①含「折叠切换」按钮', ids)
  const settingsBtn = visible.find((b) => b.aria === '设置' || b.haspopup === 'dialog')
  assert(!!settingsBtn, '②官方「设置」按钮仍在可见集中', visible.map((b) => b.aria))
  assert(!!settingsBtn && settingsBtn.haspopup === 'dialog', '②设置按钮保留 aria-haspopup=dialog（官方点击链路未改）', settingsBtn && settingsBtn.haspopup)

  const allSmall = visible.every((b) => b.rect.w === 32 && b.rect.h === 32)
  assert(allSmall, '①四个按钮均为 32×32 小方钮', visible.map((b) => b.rect.w + 'x' + b.rect.h))
  const tops = visible.map((b) => b.rect.t)
  const sameRow = Math.max(...tops) - Math.min(...tops) <= 2
  assert(sameRow, '①四个按钮横排在同一行', tops)
  const lefts = visible.map((b) => b.rect.l).sort((a, b) => a - b)
  const noOverlap = lefts.every((l, i) => i === 0 || l >= lefts[i - 1] + 32)
  assert(noOverlap, '①按钮横向不重叠', lefts)

  // ── 按键行固定在底栏**最底部**（用户口径）──
  // 真实环境下第三方插件（dsh-cost-meter）会把自己的余额/花费行插在插槽里，
  // 它们必须在上方，壳的 4 个按钮压在最底行。
  const layout = await view.webContents.executeJavaScript(`(() => {
    const foot = document.querySelector('[class*="footArea"]')
    const fr = foot.getBoundingClientRect()
    const btnSel = '.dsh-exo-foot-btn, [class*="triggerRow"] > button[class*="trigger"]'
    const btns = [...document.querySelectorAll(btnSel)].filter((b) => {
      const r = b.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.top >= fr.top - 1 && r.bottom <= fr.bottom + 1
    })
    // 第三方插槽内容（排除壳自己的组与官方设置行）
    const others = [...document.querySelectorAll('[data-slot="sidebar.footer.action"] > *')]
      .filter((el) => !el.classList.contains('dsh-exo-foot-group'))
      .map((el) => { const r = el.getBoundingClientRect(); return { cls: String(el.className || '').slice(0, 40), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), fixed: getComputedStyle(el).position === 'fixed' } })
      .filter((e) => e.h > 0 && !e.fixed)
    return {
      btnTops: btns.map((b) => Math.round(b.getBoundingClientRect().top)),
      btnBottoms: btns.map((b) => Math.round(b.getBoundingClientRect().bottom)),
      footBottom: Math.round(fr.bottom),
      others
    }
  })()`)
  const maxBtnBottom = Math.max(...layout.btnBottoms)
  assert(layout.footBottom - maxBtnBottom <= 8,
    '★ 按键行压在底栏最底部（按钮底边贴近底栏底边 ≤8px）', { footBottom: layout.footBottom, maxBtnBottom, layout })
  const nonFixed = layout.others
  const allAbove = nonFixed.every((e) => e.bottom <= Math.min(...layout.btnTops) + 2)
  assert(allAbove, '★ 第三方插槽内容均在按键行**上方**', { others: nonFixed, btnTops: layout.btnTops })

  // ★ 第三方内容必须**铺满整行**（从底栏左边缘开始）
  // 旧实现把设置列当流内 flex item 占 1/4 宽，第三方内容被挤到右 3/4、左侧空一截
  // （实测 footArea x=12..268、footerActions x=76..268 → 左 64px 空白）。
  // 现改为设置列绝对定位（脱离横向流），第三方内容从 footArea.left 开始。
  const fill = await view.webContents.executeJavaScript(`(() => {
    const foot = document.querySelector('[class*="footArea"]')
    const fr = foot.getBoundingClientRect()
    const actions = document.querySelector('[class*="footerActions"]')
    const ar = actions.getBoundingClientRect()
    // 底栏内**画出来的内容**最左边缘（排除壳的组与官方设置行）
    const slot = document.querySelector('[data-slot="sidebar.footer.action"]')
    let minLeft = null
    for (const el of slot.children) {
      if (el.classList.contains('dsh-exo-foot-group')) continue
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      if (getComputedStyle(el).position === 'fixed') continue
      if (minLeft === null || r.left < minLeft) minLeft = Math.round(r.left)
    }
    // 壳按钮组的左内边距（用于确认它是 padding 而非流内占位）
    const group = document.querySelector('.dsh-exo-foot-group')
    return {
      footLeft: Math.round(fr.left), footRight: Math.round(fr.right), footW: Math.round(fr.width),
      actionsLeft: Math.round(ar.left), actionsW: Math.round(ar.width),
      thirdPartyMinLeft: minLeft,
      groupPadLeft: group ? getComputedStyle(group).paddingLeft : null
    }
  })()`)
  assert(fill.thirdPartyMinLeft !== null && fill.thirdPartyMinLeft - fill.footLeft <= 2,
    '★ 第三方内容铺满整行（左侧无空白间隙）', fill)
  assert(fill.actionsLeft - fill.footLeft <= 2 && Math.abs(fill.actionsW - fill.footW) <= 2,
    '★ footerActions 占满底栏全宽（设置列已脱离横向流）', fill)

  assert(wide.collapseBarDisplay === 'none', '⑥dsh-ui-tools 整行工具条已收起（display:none）', wide.collapseBarDisplay)
  // 注意：底栏总高会被**第三方插件自己的内容行**撑高（实测 dsh-cost-meter 的 cm-footer-stack
  // 余额栈 93px），这是正确行为（不能为了好看压掉插件内容）。所以这里校验的是
  // 「壳自己的按钮行只有一行」= 4 个按钮都在同一行（上方已断言）且官方设置行不再单独占行。
  const settingsTop = visible.find((b) => b.haspopup === 'dialog')?.rect.t
  assert(Math.max(...tops) - Math.min(...tops) <= 2 && settingsTop === Math.min(...tops),
    '⑥设置按钮与壳按钮同排（官方设置行不再独占一行）', { tops, settingsTop })
  assert(wide.footScrollable === 0, '⑥底部区无溢出滚动', wide.footScrollable)

  // ③ 点击网页版
  await view.webContents.executeJavaScript(`document.getElementById('dsh-exo-webpanel-entry').click()`)
  await sleep(600)
  assert(received.includes('webpanel:toggle'), '③点击网页版 → 桥收到 webpanel:toggle', received)

  // ④ 点击管理面板
  await view.webContents.executeJavaScript(`document.getElementById('dsh-exo-panel-entry').click()`)
  await sleep(600)
  assert(received.includes('panel:open'), '④点击管理面板 → 桥收到 panel:open', received)

  // ⑤ 点击折叠切换 → 官方按钮被触发（分组 aria-expanded 全部收起）
  // 先归一到一个确定的起点：按钮是「反向 toggle」，先点一次使所有分组收起，
  // 再点一次应全部展开（不假定环境初始状态，否则分组本就处于收起时断言会假失败）。
  const readStates = () => view.webContents.executeJavaScript(
    `[...document.querySelectorAll('[data-slot="sidebar.workspaces"] [aria-expanded]')].filter((el) => el.tagName !== 'BUTTON').map((el) => el.getAttribute('aria-expanded'))`
  )
  const before = wide.expandedStates
  await view.webContents.executeJavaScript(`document.getElementById('dsh-exo-collapse-toggle').click()`)
  await sleep(1200)
  const after = await readStates()
  if (!after.every((v) => v === 'false')) {
    // 起点本就是全收起 → 这次点击已把它展开，再点一次回到收起
    await view.webContents.executeJavaScript(`document.getElementById('dsh-exo-collapse-toggle').click()`)
    await sleep(1200)
  }
  const collapsedStates = await readStates()
  assert(collapsedStates.length > 0 && collapsedStates.every((v) => v === 'false'), '⑤点折叠切换 → 官方插件分组全部收起', { before, after, collapsedStates })
  // 再点一次应展开
  await view.webContents.executeJavaScript(`document.getElementById('dsh-exo-collapse-toggle').click()`)
  await sleep(1200)
  const again = await readStates()
  assert(again.length > 0 && again.every((v) => v === 'true'), '⑤再点一次 → 官方插件分组全部展开（按钮是双向 toggle）', again)

  // 触发后的图标/文案应与新状态一致
  const toggleState = await view.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('dsh-exo-collapse-toggle')
    return { title: b.getAttribute('title'), aria: b.getAttribute('aria-label'), disabled: b.getAttribute('data-disabled') }
  })()`)
  assert(toggleState.disabled === null, '⑤折叠按钮处于可用态（找到官方按钮）', toggleState)
  assert(/展开|折叠/.test(toggleState.title || ''), '⑤折叠按钮文案随状态切换', toggleState)

  // ⑧ 自愈
  await view.webContents.executeJavaScript(`document.getElementById('dsh-exo-panel-entry').remove(); document.getElementById('dsh-exo-collapse-toggle').remove(); true`)
  await sleep(1200)
  const healed = await view.webContents.executeJavaScript(
    `!!document.getElementById('dsh-exo-panel-entry') && !!document.getElementById('dsh-exo-collapse-toggle')`
  )
  assert(healed === true, '⑧删除后自愈补回壳按钮', healed)

  // ⑨ 宽态截图
  // 按底栏实际位置裁切（不用写死的 y：第三方插件会把底栏顶高，固定值会裁到插件行）
  try {
    const box = await view.webContents.executeJavaScript(`(() => {
      const f = document.querySelector('[class*="footArea"]').getBoundingClientRect()
      return { x: Math.max(0, Math.round(f.left) - 6), y: Math.max(0, Math.round(f.top) - 6), width: Math.round(f.width) + 12, height: Math.round(f.height) + 12 }
    })()`)
    const shot = await view.webContents.capturePage(box)
    const f = path.join(app.getPath('temp'), 'sidebar-footer-wide.png')
    fs.writeFileSync(f, shot.toPNG())
    console.log('SHOT_WIDE=' + f + ' (box=' + JSON.stringify(box) + ')')
  } catch { /* noop */ }

  // ⑦ 收起侧边栏 → 窄条只留设置
  await view.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('button')]
    const t = btns.find((b) => /收起侧边栏|Collapse sidebar/.test(b.getAttribute('aria-label') || ''))
    if (t) t.click()
    return !!t
  })()`)
  await sleep(1500)
  await view.webContents.executeJavaScript(`(() => { try { return window.__dshExoFootSync() } catch (e) { return 'err' } })()`)
  await sleep(400)
  const rail = await view.webContents.executeJavaScript(SURVEY_RAIL)
  console.log('\n===== 窄态采样 =====')
  console.log(JSON.stringify(rail, null, 1))
  const railVisible = rail.buttons.filter((b) => b.visible)
  assert(rail.sidebarWidth <= 80, '⑦侧边栏已收起成窄条（≤80px）', rail.sidebarWidth)
  assert(rail.footRailAttr === 'rail', '⑦窄态切到 rail 标记', rail.footRailAttr)
  assert(railVisible.length === 1 && (railVisible[0].aria === '设置'), '⑦窄态只显示「设置」按钮', railVisible.map((b) => b.aria))
  assert(rail.docScrollX === 0, '⑦窄态无横向溢出', rail.docScrollX)

  try {
    const box = await view.webContents.executeJavaScript(`(() => {
      const f = document.querySelector('[class*="footArea"]').getBoundingClientRect()
      return { x: Math.max(0, Math.round(f.left) - 6), y: Math.max(0, Math.round(f.top) - 6), width: Math.round(f.width) + 12, height: Math.round(f.height) + 12 }
    })()`)
    const shot = await view.webContents.capturePage(box)
    const f = path.join(app.getPath('temp'), 'sidebar-footer-rail.png')
    fs.writeFileSync(f, shot.toPNG())
    console.log('SHOT_RAIL=' + f + ' (box=' + JSON.stringify(box) + ')')
  } catch { /* noop */ }

  console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====`)
  try { child.kill() } catch { /* noop */ }
  app.exit(failed === 0 ? 0 : 1)
})
