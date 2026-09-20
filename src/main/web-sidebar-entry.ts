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
 *
 * 底部工具栏（buildSidebarFooterScript + sidebarFooterCss，实测见
 * scripts/probe/probe-sidebar-footer.cjs / probe-footer-rail.cjs）：
 * 官方底部区是 `footArea` 两行——`footerActions`（插槽 sidebar.footer.action，
 * 第三方插件与壳注入按钮都落这里）在上一行，`settingsArea`（官方「设置」整行大按钮
 * 260×42）在下一行，共占 119px 高。壳把它重排成**一行 4 个小按钮**：
 * 设置 / 网页版 DeepSeek / 管理面板 / 折叠切换，全部 32×32。
 * - **只改 CSS 不搬 DOM**：布局用哈希无关的 `[class*="footArea"]` 等属性选择器 +
 *   壳打在 footArea 上的 `data-dsh-exo-rail` 标记（宽/窄两态，窄条只留设置按钮）；
 * - **官方设置按钮原样保留**：缩成方形的只是它的盒子，onClick 仍是官方那个，
 *   所以「打开 DSH 设置弹窗」行为不变；
 * - **折叠/展开合并成一个按钮**：视觉上隐藏 dsh-ui-tools 的整行工具条
 *   （`.wc-collapse-bar`，宽 256×36 两个 114px 按钮），点击时按当前分组状态
 *   转发 click 给官方那个按钮（找不到插件按钮则保持禁用，不静默失效）。
 */

/** 官方网页版地址（脚本内联 + 视图加载共用） */
export const DEEPSEEK_WEB_URL = 'https://chat.deepseek.com'
/** 侧边栏底部插槽（官方标记，稳定锚点） */
const FOOTER_SLOT_SELECTOR = '[data-slot="sidebar.footer.action"]'
/** 注入节点的 id（幂等标记：已存在则不重复插） */
const ENTRY_ID = 'dsh-exo-webpanel-entry'
/** 页面 → 壳的切换消息通道（复用 dsh-view preload 的 __dshExo.send） */
export const WEBPANEL_TOGGLE_CHANNEL = 'webpanel:toggle'
/** 页面 → 壳：打开壳管理面板（Dashboard，网页版/管理面板之外的第三个底部入口） */
export const PANEL_OPEN_CHANNEL = 'panel:open'
/** 底部工具栏样式表 id（入口脚本与工具栏脚本共用，幂等：谁先注入都一样） */
const FOOT_STYLE_ID = 'dsh-exo-foot-style'
/** 壳注入的底部小按钮通用类名 */
const FOOT_BTN_CLASS = 'dsh-exo-foot-btn'
/**
 * 壳的 3 个底部按钮的**组容器**类名。
 *
 * 为何要单独包一层（而不是把 3 个按钮直接摆在插槽里）：
 * 第三方插件（实测 dsh-cost-meter）会把自己的元素插到插槽**最前面**且占满整行，
 * 直接摆放时壳按钮会与它混在同一个 wrap 上下文里、被顶到它下面（实测底栏高 131px）。
 * 包一层 `flex-basis:100%` 的组后，组必定独占**最后一行** → 按键行永远压在底栏最底部，
 * 第三方内容（余额/今日花费等）在它上方。这也是「不搬动第三方节点」的前提下
 * 唯一能稳定控制行序的做法（搬节点会与 React 重渲染互相触发，见 §7 已知坑 2）。
 */
const FOOT_GROUP_CLASS = 'dsh-exo-foot-group'
/** 管理面板入口按钮 id */
const PANEL_ENTRY_ID = 'dsh-exo-panel-entry'
/** 折叠/展开合并按钮 id */
const COLLAPSE_TOGGLE_ID = 'dsh-exo-collapse-toggle'
/** footArea 上的宽/窄态标记属性（CSS 据此只在展开态重排） */
const RAIL_ATTR = 'data-dsh-exo-rail'
/** 窄条（rail）宽度阈值：实测展开 280px ↔ 收起 56px */
const RAIL_WIDTH_THRESHOLD = 100

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

    const CSS_ID = ${JSON.stringify(FOOT_STYLE_ID)}
    const BTN_CLASS = ${JSON.stringify(FOOT_BTN_CLASS)}
    function ensureStyle () {
      if (document.getElementById(CSS_ID)) return
      const s = document.createElement('style')
      s.id = CSS_ID
      s.textContent = ${JSON.stringify(sidebarFooterCss())}
      document.head.appendChild(s)
    }

    function build () {
      const btn = document.createElement('button')
      btn.id = ID
      btn.type = 'button'
      btn.className = BTN_CLASS
      btn.title = '打开 / 关闭网页版 DeepSeek'
      btn.setAttribute('aria-label', btn.title)
      btn.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/>' +
        '<path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        try { window.__dshExo && window.__dshExo.send(TOGGLE, {}) } catch {}
      })
      return btn
    }

    function sync () {
      // 样式表与底部重排规则统一由 FOOT_STYLE_ID 承担（工具栏脚本可能先跑，幂等）
      try { window.__dshExoFootEnsureStyle && window.__dshExoFootEnsureStyle() } catch {}
      const slot = document.querySelector(SLOT)
      if (!slot) return false
      ensureStyle()
      let btn = document.getElementById(ID)
      if (!btn || !slot.contains(btn)) {
        btn = build()
        // 插到插槽首位 → 排在第三方行之前（底部工具栏里紧跟「设置」）
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
 * 侧边栏底部工具栏 CSS（纯 CSS 重塑官方底部区，不搬 DOM）。
 *
 * 选择器全部用**哈希无关**的属性匹配（`[class*="footArea"]` / `[class*="trigger"]`），
 * 官方 CSS module 类名带 hash（实测 footArea=`hHd-Xa_footArea`、设置按钮=`VOzbGW_trigger`），
 * 不能直接写。作用域统一挂在 `[${RAIL_ATTR}]` 上——该标记由工具栏脚本打在 footArea 上，
 * **只在展开态（列宽 > ${RAIL_WIDTH_THRESHOLD}px）出现**，所以：
 * - 窄条（rail）态天然回落到官方原样式（rail 只有 36px 宽，排不下 4 个按钮）；
 * - 内核升级/注入脚本未跑到时，页面上没有标记，官方布局照旧（降级安全）。
 */
export function sidebarFooterCss(): string {
  // footArea 自身就带这个标记属性，所以前缀选择器直接写成「同类名 + 属性」，
  // 其内部元素（footerActions/settingsArea/triggerRow）用后代选择器即可。
  const wide = `[class*="footArea"][${RAIL_ATTR}="wide"]`
  const rail = `[class*="footArea"][${RAIL_ATTR}="rail"]`
  return [
    '/* 底部区：两行并一行，4 个按钮在整行内自适应均分，且**始终压在底栏最底部**。 */',
    '/* 关键：设置列用绝对定位**脱离横向流**，第三方插槽内容才能铺满整行（否则第三方 */',
    '/* 内容被挤在右 3/4，左侧空出一截——实测 x=12..76 为空、第三方从 x=76 才开始）。 */',
    `${wide}{position:relative;flex-direction:column;align-items:stretch;gap:0;padding:2px 0 4px;box-sizing:border-box}`,
    // footerActions：第三方插槽内容与壳按钮组都在这一个 wrap 上下文里，宽 **100%**
    // → 第三方“整行”元素（余额栈 `flex:1 1 100%`）从底栏最左开始铺满，不再被挤窄。
    // 保留官方 wrap：第三方各行堆在上，壳按钮组 basis 100% 必定换到**最后一行**。
    `${wide} [class*="footerActions"]{display:flex;width:100%;flex-wrap:wrap;min-width:0;align-content:flex-start;justify-content:flex-start}`,
    // 设置列：**绝对定位**到底栏左下角，宽 = 整行的 1/4（即四个按钮均分后第一个的槽位），
    // 高 = 32px 按钮高，坐标与壳按钮组同行同高 → 四个按钮仍精确均分；
    // 因为它不在流内，不再占用第三方内容的横向空间（修「左侧空一截」）。
    // 为何宽是 25% 而不是固定值：均分要求设置按钮中心在行宽 1/8 处，即其容器中心也是 1/8，
    // 而左边缘贴 0 → 容器宽 25% 时中心恰为 12.5% ✓（与行宽无关，自适应）。
    `${wide} [class*="settingsArea"]{display:flex;position:absolute;left:0;bottom:4px;width:25%;height:32px;justify-content:center;align-items:center}`,
    // 注：bottom 与 footArea 的 padding-bottom（4px）对齐，使设置按钮与壳按钮组**同行同高**；
    // 改 padding 时这里要同步改（否则设置按钮会浮起/下沉几像素）。
    // 壳按钮组：占满一整行（basis 100%）→ 无论第三方内容多少行，它必定落在**最后一行**；
    // order:1 使它在同一 wrap 上下文里排在第三方内容之后（不搬动第三方节点，符合 §7 已知坑 2）。
    //
    // 组内均分的关键：**padding-left:25% + justify-content:space-around**。
    // 为何不能直接 space-around：3 项 space-around 的中心是 1/6·1/2·5/6，而我们要的是
    // 3/8·5/8·7/8（与设置按钮 1/8 连成四等分）。推导（设整行 L、左内边距 p、内容宽 W=L-p）：
    //   要求 p + W/6 = 3L/8、p + W/2 = 5L/8、p + 5W/6 = 7L/8
    //   由第二式得 p = 5L/8 - W/2，代入第一式 → W = 3L/4，故 p = L/4 = 25%。
    // 验证（L=256）：内容区 192、槽宽 64，中心 = 64+32、64+96、64+160 = 96/160/224 = 3/8·5/8·7/8 ✓
    // box-sizing:border-box 保证 25% 内边距不被额外加到宽度上（否则会横向溢出）。
    `.${FOOT_GROUP_CLASS}{display:flex;order:1;flex:1 1 100%;flex-wrap:nowrap;align-items:center;min-width:0;`, 
    `box-sizing:border-box;padding-left:25%;justify-content:space-around}`,
    // ── 4 个按钮在整行内**自适应均分**（不同侧栏宽度下都等间距）──
    // 难点：设置按钮在 settingsArea、另 3 个在 footerActions 的壳按钮组里，是两个并列容器。
    // 做法：设置列宽度固定为整行的 25%（且不在流内）→ 其中心在行宽 1/8 处；
    // 壳按钮组 padding-left:25% + space-around → 中心为 3L/8, 5L/8, 7L/8（见组规则处的推导）。
    // 这是**精确等价于 4 等分**的（与按钮宽度 w 无关），侧栏宽度变化时自动跟随。
    // 官方设置行：260×42 整行按钮 → 32×32 小方钮（内部图标 16px 不变）。
    // 只改盒子，onClick 仍是官方那个 → DSH 设置弹窗行为不变；flex:0 0 auto 防被均分拉宽。
    `${wide} [class*="triggerRow"]{width:auto;margin:0;gap:0}`,
    `${wide} [class*="triggerRow"] > button[class*="trigger"]{flex:0 0 auto;width:32px;height:32px;padding:0;border-radius:8px;justify-content:center;gap:0}`,
    // 标签文字隐藏：小方钮里只留图标（与其余三个壳按钮一致）
    `${wide} [class*="triggerLabel"]{display:none}`,
    // 官方设置按钮内层 slot 包裹（display:contents）在 32px 盒子里要居中
    `${wide} [class*="triggerRow"] [data-slot="settings.trigger"]{display:flex;align-items:center;justify-content:center}`,
    // 第三个入口（网页版 DeepSeek）已由入口脚本插入插槽；插槽**保持官方 display:contents**，
    // 不要在这里改成 flex —— 改了会给第三方插槽内容造出一个嵌套 flex 上下文，把
    // dsh-cost-meter 这类「整行」元素（flex:1 1 100%）困在插槽内部换行，
    // 而官方+插件本来的约定是让它们直接参与 footerActions 的 wrap（实测 0.9.4 前即如此）。
    // 窄条（rail）态：排不下 4 个按钮 —— 只留官方「设置」小圆钮（用户确认的口径），
    // 其余三个壳入口（连同容器）隐藏，避免溢出到侧边栏外面。
    `${rail} .${FOOT_BTN_CLASS}, ${rail} .${FOOT_GROUP_CLASS}{display:none}`,
    // dsh-ui-tools 的整行工具条：折叠/展开合并为壳的一个按钮 → 视觉隐藏原工具条。
    // 用 display:none 而非 visibility，避免它仍占 256×36 把行高撑开；
    // 节点本身保留在 DOM 里，壳按钮靠转发它的 click 工作（见 buildSidebarFooterScript）。
    `.wc-collapse-bar{display:none !important}`,
    // 壳注入的小按钮通用样式（与官方设置小方钮同尺寸同质感）。
    // flex:0 0 auto —— 宽度固定 32px，不被组容器的 space-around 拉伸，
    // 间距完全交给 .dsh-exo-foot-group 的 justify-content:space-around 均分。
    `.${FOOT_BTN_CLASS}{box-sizing:border-box;flex:0 0 auto;width:32px;height:32px;padding:0;margin:0;`,
    'display:inline-flex;align-items:center;justify-content:center;gap:0;border:0;border-radius:8px;',
    'background:transparent;color:var(--dsw-alias-label-secondary,var(--dsh-text-2,#a6adb8));',
    'font:inherit;cursor:pointer;transition:background-color .12s ease,color .12s ease}',
    `.${FOOT_BTN_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,var(--dsh-text-1,#f0f3f7))}`,
    `.${FOOT_BTN_CLASS}:focus-visible{outline:2px solid rgba(80,140,255,.75);outline-offset:1px}`,
    `.${FOOT_BTN_CLASS}[data-disabled="1"]{opacity:.4;cursor:default}`,
    `.${FOOT_BTN_CLASS}[data-active="1"]{color:#e8b85a}`,
    `.${FOOT_BTN_CLASS}[data-active="1"]:hover{background:rgba(232,184,90,.14)}`,
    `.${FOOT_BTN_CLASS} svg{flex:0 0 auto;opacity:.95}`
  ].join('')
}

/**
 * 侧边栏底部工具栏脚本：把官方底部区重排为一行 4 个小按钮。
 *
 * 四个入口（从左到右：设置 / 网页版 DeepSeek / 管理面板 / 折叠切换）：
 *   1. **设置** —— 官方 `[class*="triggerRow"] > button`，**原样保留**（不新建、不代理），
 *      只由 CSS 缩成 32×32，点击照旧打开 DSH 设置弹窗；
 *   2. **网页版 DeepSeek** —— 由 `buildSidebarEntryScript` 注入（保持既有链路）；
 *   3. **管理面板** —— 本脚本新建，经 `__dshExo.send('panel:open')` 回壳；
 *   4. **折叠切换** —— 本脚本新建，隐藏了 dsh-ui-tools 的整行工具条，
 *      点击时**转发 click 给官方那两个按钮之一**（按当前分组展开状态选目标）。
 *
 * 为什么不自建折叠逻辑：`setAllGroupsExpanded` 在插件内部，依赖 `ctx.slots`/store；
 * 壳无法从页面侧调用，只能转发官方按钮的 click（实测两个按钮的 aria-label 稳定：
 * 「折叠所有工作区」/「展开所有工作区」）。找不到官方按钮时按钮置 `data-disabled` 并
 * 提示，不静默失效。
 *
 * 状态判定（实测 `scripts/probe/probe-footer-rail.cjs`）：工作区分组头是
 * `[slot="sidebar.workspaces"] div[class*="projectRow"][aria-expanded]`，
 * 只要有任一分组是展开的，按钮就呈现「折叠」面（通用 toggle 语义）。
 */
export function buildSidebarFooterScript(): string {
  return `(() => {
    const STYLE_ID = ${JSON.stringify(FOOT_STYLE_ID)}
    const BTN_CLASS = ${JSON.stringify(FOOT_BTN_CLASS)}
    const GROUP_CLASS = ${JSON.stringify(FOOT_GROUP_CLASS)}
    const BTN_PANEL = ${JSON.stringify(PANEL_ENTRY_ID)}
    const BTN_COLLAPSE = ${JSON.stringify(COLLAPSE_TOGGLE_ID)}
    const RAIL_ATTR = ${JSON.stringify(RAIL_ATTR)}
    const RAIL_MAX = ${RAIL_WIDTH_THRESHOLD}
    const SEND_CHANNEL = ${JSON.stringify(PANEL_OPEN_CHANNEL)}

    function ensureStyle () {
      if (document.getElementById(STYLE_ID)) return
      const s = document.createElement('style')
      s.id = STYLE_ID
      s.textContent = ${JSON.stringify(sidebarFooterCss())}
      document.head.appendChild(s)
    }
    window.__dshExoFootEnsureStyle = ensureStyle

    function sidebarWidth () {
      try {
        const col = document.querySelector('[class*="sidebarCol"]')
        if (col) { const w = Math.round(col.getBoundingClientRect().width); if (w > 0) return w }
      } catch {}
      return 0
    }

    function footArea () { return document.querySelector('[class*="footArea"]') }

    // 官方「设置」行（仅用于定位，不搬动、不复制）
    function settingsRow () { return document.querySelector('[class*="triggerRow"]') }

    // dsh-ui-tools 的折叠/展开按钮（可能因为插件未启用而不存在）。
    // 必须限定在 .wc-collapse-bar 内：壳自己的折叠按钮 aria-label 与官方同名，
    // 全局 querySelector 会先命中壳自己 → 转发变成自点（实测踩过，按钮永久失效）。
    function officialCollapseButton () {
      return document.querySelector('.wc-collapse-bar button[aria-label="折叠所有工作区"]')
    }
    function officialExpandButton () {
      return document.querySelector('.wc-collapse-bar button[aria-label="展开所有工作区"]')
    }

    // 是否有任一分组处于展开态（决定折叠按钮呈现哪一面）
    // 语义取「通用 toggle」：只要还有展开的就给「折叠」，全收起才给「展开」；
    // 否则混合状态下按钮会一直停在「展开」，用户点不出「一键收起」。
    function anyExpanded () {
      try {
        const rows = document.querySelectorAll('[data-slot="sidebar.workspaces"] [aria-expanded]')
        for (const r of rows) {
          // 排除按钮自身（官方搜索按钮也带 aria-expanded，与分组无关）
          if (r.tagName === 'BUTTON') continue
          if (r.getAttribute('aria-expanded') === 'true') return true
        }
        return false
      } catch { return false }
    }

    const ICON_COLLAPSE =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/></svg>'
    const ICON_EXPAND =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>'
    const ICON_PANEL =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<path d="M3 9h18"/><path d="M9 21V9"/></svg>'

    function makeButton (id, label, svg) {
      const btn = document.createElement('button')
      btn.id = id
      btn.type = 'button'
      btn.className = BTN_CLASS
      btn.title = label
      btn.setAttribute('aria-label', label)
      btn.innerHTML = svg
      return btn
    }

    function buildPanelButton () {
      const btn = makeButton(BTN_PANEL, '打开管理面板', ICON_PANEL)
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        try { window.__dshExo && window.__dshExo.send(SEND_CHANNEL, {}) } catch {}
      })
      return btn
    }

    function buildCollapseButton () {
      const btn = makeButton(BTN_COLLAPSE, '折叠所有工作区', ICON_EXPAND)
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        // 按当前状态选目标：还有展开的 → 折叠；全部收起 → 展开
        const target = anyExpanded() ? officialCollapseButton() : officialExpandButton()
        if (!target) return
        target.click()
        // 官方状态是异步落盘的，稍后再同步一次图标/文案
        setTimeout(() => { try { syncCollapse() } catch {} }, 80)
      })
      return btn
    }

    function syncCollapse () {
      const btn = document.getElementById(BTN_COLLAPSE)
      if (!btn) return
      const enabled = !!(officialCollapseButton() || officialExpandButton())
      const expanded = anyExpanded()
      const label = !enabled ? '折叠/展开工作区（需启用 dsh-ui-tools 插件）' : expanded ? '折叠所有工作区' : '展开所有工作区'
      // 只在状态真的变了才改 DOM（每秒同步一次，重写 innerHTML 会白建 SVG）
      const key = (enabled ? '1' : '0') + (expanded ? '1' : '0')
      if (btn.__dshExoKey === key) return
      btn.__dshExoKey = key
      btn.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND
      btn.title = label
      btn.setAttribute('aria-label', label)
      if (enabled) btn.removeAttribute('data-disabled')
      else btn.setAttribute('data-disabled', '1')
    }

    /**
     * 把壳的 3 个按钮放进**组容器**（.dsh-exo-foot-group）并挂到插槽末尾。
     *
     * 为何要包一层组：第三方插件（实测 dsh-cost-meter）会把自己的元素插到插槽**最前面**
     * 且占满整行；若不分组，壳按钮会与它混在同一 wrap 上下文里被顶到它下面。
     * 组用 flex:1 1 100% 独占一整行，且 order:1 排在第三方内容之后
     * （见 sidebarFooterCss 注释）→ 壳按钮行**永远压在底栏最底部**，第三方内容在上。
     * 组挂在插槽**末尾**而不是最前：视觉行序由 CSS order 控制，DOM 顺序保持「第三方在前」，
     * 这样万一 CSS 未生效（降级），第三方仍按官方顺序渲染，不会出现意外。
     */
    function place (slot) {
      let group = slot.querySelector(':scope > .' + GROUP_CLASS)
      if (!group) {
        group = document.createElement('div')
        group.className = GROUP_CLASS
        // 壳按钮组是壳自己的容器：标记 aria-hidden=false 以便无障碍工具读取内部按钮；
        // 用 role=group 给屏幕阅读器一个“这是一组底部操作”的语义。
        group.setAttribute('role', 'group')
        group.setAttribute('aria-label', '壳入口')
        slot.appendChild(group)
      }
      const webpanel = document.getElementById(${JSON.stringify(ENTRY_ID)})
      if (webpanel && !group.contains(webpanel)) group.appendChild(webpanel)
      let panel = document.getElementById(BTN_PANEL)
      if (!panel) panel = buildPanelButton()
      if (!group.contains(panel)) group.appendChild(panel)
      let collapse = document.getElementById(BTN_COLLAPSE)
      if (!collapse) collapse = buildCollapseButton()
      if (!group.contains(collapse)) group.appendChild(collapse)
    }

    function sync () {
      ensureStyle()
      const foot = footArea()
      if (!foot || !settingsRow()) return 'no-foot'
      // 宽/窄两态标记：CSS 只在 wide 下重排（窄条 36px 排不下 4 个按钮）。
      // 窄态写成显式 "rail" 而不是移除属性：属性缺失 = 注入脚本还没跑完，
      // 那时壳按钮照常显示（降级安全），不用猜。
      const w = sidebarWidth()
      foot.setAttribute(RAIL_ATTR, w > RAIL_MAX ? 'wide' : 'rail')
      const slot = foot.querySelector('[data-slot="sidebar.footer.action"]')
      if (slot) place(slot)
      syncCollapse()
      return 'ok'
    }

    window.__dshExoFootSync = sync
    const first = sync()
    // 分组状态是 React 状态，点开后 DOM 会重渲染；用轻量定时器同步图标（500ms，代价可忽略）
    if (!window.__dshExoFootInstalled) {
      window.__dshExoFootInstalled = true
      let timer = null
      const schedule = () => {
        if (timer) return
        timer = setTimeout(() => { timer = null; try { sync() } catch {} }, 250)
      }
      try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }) } catch {}
      setInterval(() => { try { syncCollapse() } catch {} }, 1000)
    }
    return first
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
