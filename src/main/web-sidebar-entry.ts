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
 */
export function buildTopDragRegionCss(overlayHeight: number): string {
  return [
    '/* 顶部拖拽区（高度与原生窗口按钮叠加层对齐） */',
    `[class*="logoRow"] { -webkit-app-region: drag; min-height: ${overlayHeight}px; }`,
    '[class*="logoRow"] button, [class*="logoRow"] a, [class*="logoRow"] input, [class*="logoRow"] [role="button"] { -webkit-app-region: no-drag; }',
    // 会话头部让位（见 buildOverlaySafeAreaCss 注释）
    ...overlaySafeAreaRules(overlayHeight)
  ].join('\n')
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
    // 头部内的拖拽能力不受影响；但其可交互元素必须保持可点
    'header button, header a, header input, header [role="button"], header [role="tab"] { -webkit-app-region: no-drag; }'
  ]
}
