/**
 * 「网页版 DeepSeek」侧边栏入口注入（DSH Web UI 左侧边栏）
 *
 * 为什么用 DOM 注入而不是官方插槽注册：
 * 官方把左侧边栏开放为 `sidebar.*` 插槽（`@deepseek-ai/dsh-client-ui-sidebar`），
 * 但插槽是 **cordis 客户端插件** 的注册面——需要独立插件包（本仓 `plugins/` 已 gitignore，
 * 插件源码在各自仓库维护）。壳要「开箱即用」地提供入口，就走注入这条路：
 * 往官方插槽已渲染出来的 DOM 锚点插一个按钮，点击经既有 webview 桥（`window.__dshExo`）
 * 回壳，由壳切网页版视图。
 *
 * 锚点选择（实测依据见 scripts/probe/verify-web-sidebar-entry.cjs）：
 * - 用 `[data-slot="sidebar.footer.action"]`——官方插槽标记，**不含 hash**，跨版本稳定；
 *   CSS module 类名是 hash（实测 `pI_x6G_sidebarCol`），不可依赖。
 * - 该锚点 `display: contents`，本身不产生盒子、子元素才参与布局，
 *   故插入的按钮会自然排进侧边栏底部那一列（与 dsh-cost-meter 的「今日¥」同列）。
 * - 侧边栏整体宽度实测 280px（`[class*="sidebarCol"]`），用于把网页版视图贴在它右侧。
 */

/** 官方网页版地址（脚本内联 + 视图加载共用） */
export const DEEPSEEK_WEB_URL = 'https://chat.deepseek.com'
/** 侧边栏底部插槽（官方标记，稳定锚点） */
const FOOTER_SLOT_SELECTOR = '[data-slot="sidebar.footer.action"]'
/** 注入节点的 id（幂等标记：已存在则不重复插） */
const ENTRY_ID = 'dsh-exo-webpanel-entry'
/** 页面 → 壳的切换消息通道（复用 dsh-view preload 的 __dshExo.send） */
export const WEBPANEL_TOGGLE_CHANNEL = 'webpanel:toggle'

/**
 * 读取 DSH Web UI 左侧边栏实测宽度的脚本。
 * 优先 CSS module 列容器，回退官方插槽内最宽内部块；取不到返回 null（调用方兜底）。
 */
export function measureSidebarWidthScript(): string {
  return `(() => {
    try {
      const col = document.querySelector('[class*="sidebarCol"]')
      if (col) {
        const w = Math.round(col.getBoundingClientRect().width)
        if (w > 0) return w
      }
      const slot = document.querySelector('[data-slot="sidebar"]')
      if (slot) {
        for (const el of slot.querySelectorAll('*')) {
          const w = Math.round(el.getBoundingClientRect().width)
          if (w > 100 && w < 420) return w
        }
      }
      return null
    } catch { return null }
  })()`
}

/**
 * 侧边栏入口注入脚本（在主世界执行，需要页面上下文里的 `window.__dshExo`）。
 *
 * 行为：
 * - **幂等**：`window.__dshExoWebPanelInstalled` + 节点 id 双重判重，重复执行只做同步；
 * - **自愈**：React 重渲染会清掉外部节点，用 MutationObserver 节流补插；
 * - **选中态**：由壳通过 `setSidebarEntryActiveScript` 直接写 `__dshExoWebPanelActive`，
 *   不额外开推送通道（避免扩大 dsh-view preload 的白名单面，R-27）。
 */
export function buildSidebarEntryScript(): string {
  return `(() => {
    const ID = ${JSON.stringify(ENTRY_ID)}
    const SLOT = ${JSON.stringify(FOOTER_SLOT_SELECTOR)}
    const TOGGLE = ${JSON.stringify(WEBPANEL_TOGGLE_CHANNEL)}

    if (window.__dshExoWebPanelInstalled) {
      try { window.__dshExoWebPanelSync && window.__dshExoWebPanelSync() } catch {}
      return 'already'
    }
    window.__dshExoWebPanelInstalled = true

    const CSS_ID = ID + '-style'
    function ensureStyle () {
      if (document.getElementById(CSS_ID)) return
      const s = document.createElement('style')
      s.id = CSS_ID
      s.textContent = [
        '#' + ID + '{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;',
        'margin:0;padding:8px 12px;border:0;background:transparent;color:var(--dsh-text-2,#a6adb8);',
        'font:inherit;font-size:13px;text-align:left;cursor:pointer;border-radius:6px;',
        'transition:background .15s,color .15s}',
        '#' + ID + ':hover{background:rgba(255,255,255,.06);color:var(--dsh-text-1,#f0f3f7)}',
        '#' + ID + '[data-active="1"]{color:#e8b85a}',
        '#' + ID + '[data-active="1"]:hover{background:rgba(232,184,90,.14)}',
        '#' + ID + ' svg{flex:0 0 auto;opacity:.9}',
        '#' + ID + ' span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      ].join('')
      document.head.appendChild(s)
    }

    function build () {
      const btn = document.createElement('button')
      btn.id = ID
      btn.type = 'button'
      btn.title = '打开 / 关闭网页版 DeepSeek'
      btn.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/>' +
        '<path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>' +
        '<span>网页版 DeepSeek</span>'
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        try { window.__dshExo && window.__dshExo.send(TOGGLE, {}) } catch {}
      })
      return btn
    }

    function sync () {
      const slot = document.querySelector(SLOT)
      if (!slot) return false
      ensureStyle()
      let btn = document.getElementById(ID)
      if (!btn || !slot.contains(btn)) {
        btn = build()
        // 插到插槽首位 → 落在「设置」行上方（插槽内已有第三方行时排其前）
        slot.insertBefore(btn, slot.firstChild)
      }
      if (window.__dshExoWebPanelActive) btn.setAttribute('data-active', '1')
      else btn.removeAttribute('data-active')
      return true
    }

    window.__dshExoWebPanelSync = sync
    sync()

    // React 重渲染可能移除外部节点：观察 body，节流补插
    let timer = null
    const obs = new MutationObserver(() => {
      if (timer) return
      timer = setTimeout(() => { timer = null; try { sync() } catch {} }, 300)
    })
    obs.observe(document.body, { childList: true, subtree: true })

    return 'installed'
  })()`
}

/** 写选中态并同步按钮样式（壳在切换网页版视图后调用） */
export function setSidebarEntryActiveScript(active: boolean): string {
  return `(() => {
    try {
      window.__dshExoWebPanelActive = ${active ? 'true' : 'false'}
      if (window.__dshExoWebPanelSync) window.__dshExoWebPanelSync()
      return true
    } catch { return false }
  })()`
}

/**
 * 顶部拖拽区 CSS（无系统标题栏时的窗口拖动能力）。
 *
 * 背景：窗口用 `titleBarStyle: 'hidden'`（内容从 y=0 起、右上角原生窗口按钮叠加），
 * 顶部那一行是 DSH 自己的侧边栏品牌行（鲸鱼 logo + deepseek HARNESS）。
 * 该行 logo 本身就是「新建会话」按钮（实测 aria-label=新建会话），
 * 因此不能整行设为拖拽区（会吞掉点击）。做法：
 * - 给 DSH 的 logoRow 设 `drag`；
 * - logoRow 内部可交互元素（button / a / input）逐个设回 `no-drag`，保证点击仍有效。
 * 选择器若因版本变化落空，不影响其他功能，只是拖拽回退给系统标题栏区域。
 *
 * 中间主体那一列另有两块拖拽区（实测见 scripts/probe/probe-drag-region-dom.cjs）：
 * - **会话态**：`header` 整行设 `drag`（见 overlaySafeAreaRules 的 padding-top 让位——
 *   顶部 ${overlayHeight}px 是**空内边距**，故这一带设 drag 不会压住任何内容；
 *   header 内的按钮/图标逐个设回 `no-drag`）；
 * - **空态**（未打开会话时 DSH 不渲染有高度的 header）：由 `buildTopDragStripScript`
 *   插入一条固定定位拖拽条（实测该带内可交互元素为 0 个）。
 */
export function buildTopDragRegionCss(overlayHeight: number): string {
  return [
    '/* 顶部拖拽区（高度与原生窗口按钮叠加层对齐） */',
    `[class*="logoRow"] { -webkit-app-region: drag; min-height: ${overlayHeight}px; }`,
    '[class*="logoRow"] button, [class*="logoRow"] a, [class*="logoRow"] input, [class*="logoRow"] [role="button"] { -webkit-app-region: no-drag; }',
    // 会话头部让位（见 overlaySafeAreaRules 注释）
    ...overlaySafeAreaRules(overlayHeight)
  ].join('\n')
}

/** 空态顶部拖拽条的元素 id（幂等标记 + 自愈查找） */
export const DRAG_STRIP_ID = 'dsh-exo-drag-strip'

/**
 * Windows 原生窗口按钮簇宽度（实测 `x ∈ [W-138, W]`，系统画在内容之上）。
 * 拖拽条右边界据此让开——那一段本来就由系统接管，铺过去也没用。
 */
export const WINDOW_CONTROLS_CLUSTER_WIDTH = 138

/**
 * 空态顶部拖拽条脚本（未打开会话时中间主体顶部的窗口拖动能力）。
 *
 * 为什么需要它：会话态由 CSS 给 `header` 设 drag 即可（那一带是 header 的空白内边距），
 * 但**空态 DSH 根本不渲染有高度的 header**（实测页面上只有一个 0 高度 header），
 * 该位置最初命中的是整列高的 `div.wSkVaW_scrollBody`——它同时承载聊天区，
 * 不能设 drag（会让整个消息区无法滚轮/选中）。故空态改用一条**仅覆盖`y<overlayHeight`**
 * 的固定定位透明条。
 *
 * 三条约束（都来自实测）：
 * - **只在空态插入**：会话态下 header 自己已是拖拽区，此时若留着拖拽条，会压在标题行
 *   的面包屑等按钮上吞掉点击（实测覆盖 3 个 button）。故 `hasHeader()` 为真即移除。
 * - **左边界跟随侧边栏**：侧边栏可折叠（实测 280px ↔ 56px），固定值会要么盖住侧边栏
 *   按钮、要么在收起后留一条拖不动的缝。每次 sync 现测列宽。
 * - **右边界让开原生按钮簇**：Windows 下按钮簇占右上角 `x ∈ [W-138, W]`，系统画在内容
 *   之上，拖拽条铺到最右也没有意义（那一段本来就由系统接管）。
 *
 * 自愈：DSH 是 React 应用，重渲染可能清掉 body 下的外部节点，故与侧边栏入口同样用
 * MutationObserver 节流补插；另接 `resize`（窗口缩放）与 `ResizeObserver`（**侧边栏折叠**：
 * 实测折叠只改内部布局宽度、不改 class 名也不增删节点，childList 观察器完全看不到，
 * 只能靠尺寸变化触发）。
 */
export function buildTopDragStripScript(
  overlayHeight: number,
  clusterWidth: number,
  fallbackSidebarWidth: number
): string {
  return `(() => {
    const ID = ${JSON.stringify(DRAG_STRIP_ID)}
    const H = ${overlayHeight}
    const CLUSTER = ${clusterWidth}
    const FALLBACK_SIDEBAR = ${fallbackSidebarWidth}

    function sidebarWidth () {
      try {
        const col = document.querySelector('[class*="sidebarCol"]')
        if (col) { const w = Math.round(col.getBoundingClientRect().width); if (w > 0) return w }
      } catch {}
      return FALLBACK_SIDEBAR
    }
    function hasHeader () {
      try {
        return [...document.querySelectorAll('header')].some(function (h) { return h.getBoundingClientRect().height > 0 })
      } catch { return false }
    }

    function sync () {
      const existing = document.getElementById(ID)
      // 会话态：header 自带拖拽，拖拽条必须撤掉（否则吞掉标题行按钮的点击）
      if (hasHeader()) { if (existing) existing.remove(); return 'removed' }
      let el = existing
      if (!el) {
        el = document.createElement('div')
        el.id = ID
        el.setAttribute('aria-hidden', 'true')
        const host = document.body || document.documentElement
        if (!host) return 'no-host'
        host.appendChild(el)
      }
      const s = el.style
      s.position = 'fixed'
      s.top = '0'
      s.left = sidebarWidth() + 'px'
      s.right = CLUSTER + 'px'
      s.height = H + 'px'
      s.background = 'transparent'
      s.zIndex = '2147483000'
      s.setProperty('-webkit-app-region', 'drag')
      return 'shown'
    }

    window.__dshExoDragStripSync = sync
    const first = sync()
    if (!window.__dshExoDragStripInstalled) {
      window.__dshExoDragStripInstalled = true
      let timer = null
      const schedule = () => {
        if (timer) return
        timer = setTimeout(() => { timer = null; try { sync() } catch {} }, 300)
      }
      try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }) } catch {}
      window.addEventListener('resize', schedule)
      // 侧边栏折叠/展开只改布局宽度（不改 class、不增删节点）→ childList 观察器看不到，
      // 必须观察列元素自身的尺寸变化，否则拖拽条左边界会停在旧值上（盖住按钮或留缝）。
      try {
        const col = document.querySelector('[class*="sidebarCol"]')
        if (col && typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(col)
      } catch {}
      // 列元素可能要等 React 首次渲染后才存在，短轮询补挂（拿到即停）
      let attachTries = 0
      const attachTimer = setInterval(() => {
        attachTries += 1
        try {
          const col = document.querySelector('[class*="sidebarCol"]')
          if (col && typeof ResizeObserver === 'function') {
            new ResizeObserver(schedule).observe(col)
            clearInterval(attachTimer)
          }
        } catch {}
        if (attachTries >= 40) clearInterval(attachTimer)
      }, 500)
    }
    return first
  })()`
}

/**
 * 叠加层安全区规则：把 DSH 会话头部整行推到原生窗口按钮下方。
 *
 * 问题（实测 scripts/probe/probe-overlap-widths.cjs）：
 * Windows 下原生按钮簇占据右上角 `x ∈ [W-138, W], y ∈ [0, 36]`，系统画在内容**之上**；
 * 而 DSH 会话头部 `header` 位于 `y = 0..86`、其中 `titleRow` 在 `y = 10..42`，
 * 于是每个窗口宽度下都与按钮簇重叠 110×26 = 2860px²——右上角那排图标按钮
 * （`headerUtilities` 124×28 与 `headerCorner` 28×28）被最小化/最大化按钮盖住。
 *
 * 为什么必须由壳处理：`env(titlebar-area-*)` 实测在本应用的 WebContentsView 子视图里
 * 全是 `-1px`（未下发），DSH 自己无从避让。
 *
 * 修法：给 header 加上等于叠加层高度的顶部内边距，整行（标题 + 选项卡）下移。
 * - 用 `header` 标签选择器而非 CSS module 类名：实测类名是 hash（`wSkVaW_header`）不可依赖，
 *   而 `<header>` 语义标签全页只命中 1 个且正是目标头部（同一探针的候选命中测试）。
 * - 只加 padding-top、不改高度/外边距：header 是 grid 行，padding 会撑高该行并自然把
 *   后续内容（会话视图）下推，不会产生叠层或留白错位。
 * - `box-sizing: border-box` 下若 header 有固定高度会被压缩，故同时清掉可能的高度约束，
 *   让内容决定高度（min-height 保底原 86px，避免折叠时塌陷）。
 */
function overlaySafeAreaRules(overlayHeight: number): string[] {
  return [
    '/* 会话头部让位：整行下移到原生窗口按钮下方（避免右上角图标按钮被遮挡） */',
    `header { padding-top: ${overlayHeight}px !important; height: auto !important; min-height: ${overlayHeight + 86}px; }`,
    // 会话态拖拽区：`header` 顶部那一带正是上面 padding 让出来的空内边距，
    // 设 drag 不会压住任何内容（实测 y=6/18/28 整行命中的都是 header 自身）。
    'header { -webkit-app-region: drag; }',
    // 但 header 内部的可交互元素必须逐个设回可点，否则会被 drag 吞掉。
    // 除语义控件外还列入 svg/img：实测头部里有「图标自己带 onClick 但不在 button 内」的情况
    // （probe-drag-header-candidates 报 svg @(546,52) 解析成 drag），一并排除更稳。
    [
      'header button', 'header a', 'header input', 'header select', 'header textarea',
      'header svg', 'header img', 'header [role="button"]', 'header [role="tab"]',
      'header [role="link"]', 'header [contenteditable="true"]'
    ].join(', ') + ' { -webkit-app-region: no-drag; }'
  ]
}
