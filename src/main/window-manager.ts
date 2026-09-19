/**
 * 窗口管理（文档 §4.1.2）
 * - 无系统标题栏（titleBarStyle: 'hidden' + titleBarOverlay）：内容从 y=0 起，
 *   右上角为系统原生最小/最大/关闭按钮（叠加在内容之上，不占布局）
 * - DSH Web UI 以 WebContentsView 铺满整个内容区（顶部即 DSH 自己的侧边栏品牌行）
 * - 网页版 DeepSeek 入口由注入 DSH 左侧边栏提供（见 web-sidebar-entry）
 * - 单实例、关闭隐藏到托盘
 */
import { BrowserWindow, WebContentsView, app, shell, screen } from 'electron'
import path from 'node:path'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import { configStore } from './config'
import { notificationHub } from './notification-hub'
import { buildSidebarEntryScript, setSidebarEntryActiveScript, measureSidebarWidthScript, buildTopDragRegionCss, buildTopDragStripScript, buildSidebarFooterScript, WINDOW_CONTROLS_CLUSTER_WIDTH, DEEPSEEK_WEB_URL, WEBPANEL_TOGGLE_CHANNEL, PANEL_OPEN_CHANNEL } from './web-sidebar-entry'
import {
  SHELL_CANVAS_COLOR,
  DSH_TOP_COLOR_DARK,
  DSH_TOP_COLOR_LIGHT,
  THEME_CHANGED_CHANNEL,
  buildTopColorProbeScript,
  buildThemeWatchScript,
  normalizeCssColor,
  pickSymbolColor
} from './titlebar-overlay'
import type { DashboardTab } from '../shared/types'

/** 原生窗口按钮叠加层高度（与 DSH 侧边栏品牌行同高，视觉上连成一条） */
export const TITLEBAR_OVERLAY_HEIGHT = 36
/** 侧边栏宽度回退值（实测不到时使用；实测值见 measureSidebarWidth） */
const DEFAULT_SIDEBAR_WIDTH = 280
/** 官方网页版 DeepSeek（独立 WebContentsView 承载，入口在 DSH Web UI 左侧边栏） */
const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800
const MIN_WIDTH = 900
const MIN_HEIGHT = 600
/** 几何保存防抖（ms） */
const GEOMETRY_DEBOUNCE_MS = 500
/**
 * DSH 页面插件加载失败自愈（启动竞态）：
 * 内核刚监听时 Exoskeleton 立即挂载视图（约 40ms），此时 client-modules 的 bundle 组合
 * 可能仍在变化（第三方插件异步激活会触发重新组合 → rev 版本号变化），早期页面请求的
 * 旧 rev bundle URL 返回 404，页面显示 "Failed to load plugins"。浏览器手动访问时内核
 * 已稳定故不触发。这里轮询检测该错误横幅，发现后清缓存强制重载，直到页面健康。
 */
const DSH_VIEW_HEALTH_CHECK_MS = 1200
/** 启动初期内核 bundle 组合可持续变化约 30-60 秒（第三方插件异步激活 + compatPatch），
 *  重试间隔 2s 起步指数递增（×2、×3…封顶 10s），最多 30 次 ≈ 覆盖 3 分钟稳定期 */
const DSH_VIEW_RETRY_MAX = 30
/** 顶栏取色重试上限：页面顶栏可能比 did-finish-load 晚铺满，有限次重试后保持兜底色 */
const DSH_TOPBAR_PROBE_MAX = 6

export class WindowManager {
  private win: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private viewUrl: string | null = null
  private isQuitting = false
  private geometryTimer: NodeJS.Timeout | null = null
  /** 管理面板是否打开（打开时隐藏 DSH Web UI 视图） */
  private adminPanelVisible = false
  /** 「网页版 DeepSeek」原生视图（独立 WebContentsView，懒创建；由 DSH 侧边栏入口控制） */
  private webView: WebContentsView | null = null
  /** 网页版视图是否显示 */
  private webPanelVisible = false
  /** DSH Web UI 左侧边栏实测宽度（网页版视图贴它右侧显示） */
  private sidebarWidth = DEFAULT_SIDEBAR_WIDTH
  /** DSH 页面插件加载失败的自动重载计数与定时器（启动竞态自愈） */
  private dshViewRetryCount = 0
  private dshViewHealthTimer: NodeJS.Timeout | null = null
  /** 当前已应用到原生窗口按钮叠加层的底色（同值不重复下发，避免抖动） */
  private titleBarColor: string | null = null
  /** DSH Web UI 当前是否暗色主题（默认暗色，与 DSH 默认主题一致） */
  private dshDarkTheme = true
  /** 顶栏取色重试计数（启动期页面尚未铺满顶栏时多试几次） */
  private topColorProbeAttempts = 0

  getWindow(): BrowserWindow | null {
    return this.win
  }

  /** 读取上次保存的窗口几何；若落在当前任一显示器可见区域则恢复，否则 null（用默认居中） */
  private restoreBounds(): { width: number; height: number; x?: number; y?: number } | null {
    const saved = configStore.get().windowBounds
    if (!saved) return null
    const w = Math.max(MIN_WIDTH, Math.round(saved.width))
    const h = Math.max(MIN_HEIGHT, Math.round(saved.height))
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return saved.x + w > a.x && saved.x < a.x + a.width && saved.y + h > a.y && saved.y < a.y + a.height
    })
    if (!visible) return null
    return { width: w, height: h, x: Math.round(saved.x), y: Math.round(saved.y) }
  }

  /** 保存窗口几何（非最大化保存 bounds；最大化只记状态） */
  private persistGeometry(): void {
    if (!this.win || this.win.isDestroyed()) return
    if (this.win.isMaximized()) {
      void configStore.set({ windowMaximized: true })
      return
    }
    if (this.win.isMinimized()) return
    const b = this.win.getBounds()
    if (b.width < MIN_WIDTH || b.height < MIN_HEIGHT) return
    void configStore.set({ windowBounds: { width: b.width, height: b.height, x: b.x, y: b.y }, windowMaximized: false })
  }

  private schedulePersist(): void {
    if (this.geometryTimer) clearTimeout(this.geometryTimer)
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = null
      this.persistGeometry()
    }, GEOMETRY_DEBOUNCE_MS)
  }

  create(): BrowserWindow {
    if (this.win) return this.win

    const restored = this.restoreBounds()
    this.win = new BrowserWindow({
      width: restored?.width ?? DEFAULT_WIDTH,
      height: restored?.height ?? DEFAULT_HEIGHT,
      ...(restored ? { x: restored.x, y: restored.y } : {}),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      // 无系统标题栏：内容从 y=0 起；右上角由系统原生按钮叠加（titleBarOverlay）
      // 不用 frame:false 的原因：那样没有任何原生窗口控件，得自己画三个按钮；
      // titleBarStyle:'hidden' + overlay 则既有原生按钮、又不占内容空间。
      // 底色用壳画布色起步（启动瞬间窗口被 DSH 视图覆盖前的底色），随后由
      // syncTitleBarOverlay 按「当前在上的表面 + 该页面主题」同步，避免右上角
      // 三个按钮压在另一种颜色上（实测旧值 #0b0f17 vs DSH 顶栏 #151517）。
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: SHELL_CANVAS_COLOR,
        symbolColor: pickSymbolColor(SHELL_CANVAS_COLOR),
        height: TITLEBAR_OVERLAY_HEIGHT
      },
      title: 'DSH-Exoskeleton',
      backgroundColor: SHELL_CANVAS_COLOR,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false
      }
    })

    // 打开外部链接交给系统浏览器
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    this.win.webContents.on('will-navigate', (event, url) => {
      const rendererUrl = process.env.ELECTRON_RENDERER_URL
      if (rendererUrl && url.startsWith(rendererUrl)) return
      if (url.startsWith('file://')) return
      event.preventDefault()
      void shell.openExternal(url)
    })

    this.win.on('close', (e) => {
      if (!this.isQuitting) {
        // 关闭 = 隐藏到托盘（文档 §4.1.3）
        e.preventDefault()
        this.win?.hide()
      }
    })
    this.win.on('maximize', () => this.persistGeometry())
    this.win.on('unmaximize', () => this.schedulePersist())
    this.win.on('resize', () => {
      this.layoutView()
      // 窗口尺寸变了拖拽条横向范围也变（页面内 resize 监听在 WebContentsView 场景不一定触发）
      this.syncDragStrip()
      // 底部工具栏的宽/窄态同理（侧边栏折叠只改布局宽度，页面内观察器看不到）
      this.syncSidebarFooter()
      this.schedulePersist()
    })
    this.win.on('move', () => this.schedulePersist())
    this.win.once('ready-to-show', () => {
      this.win?.show()
      // 叠加层底色与初始表面（壳画布）对齐
      this.syncTitleBarOverlay()
      // 恢复最大化状态（先 show 再最大化，确保布局正常）
      if (configStore.get().windowMaximized) {
        this.win?.maximize()
      }
    })

    this.loadRenderer()

    // 通知点击回执 → 唤起窗口（webview 通道；会话激活由页面内插件 ctx.sessions.open 完成）
    notificationHub.setOnClick(() => this.show())

    // 窗口激活探针 → 通知 auto 路由（焦点感知）：DSH 窗口是前台焦点且 webview 可见才用
    // 页面内 toast；失焦/最小化/隐藏/管理面板打开（webview 被隐藏）→ 原生通知，防漏看
    notificationHub.setWindowActive(() => this.isWindowActive())

    // 状态变化时通知 renderer（仪表盘状态点/版本信息）
    dshManager.on('statusChange', (state) => {
      this.win?.webContents.send('dsh:statusChange', state)
    })
    return this.win
  }

  private loadRenderer(): void {
    const win = this.win
    if (!win) return
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
    win.webContents.on('did-finish-load', () => this.layoutView())
  }

  /** 在内容区挂载 DSH Web UI */
  attachDshView(url: string): void {
    if (!this.win) return
    if (this.view) {
      this.detachDshView()
    }
    this.viewUrl = url
    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        // 设计 §5：DSH 视图专用预加载桥（window.__dshExo 白名单，与主壳 preload 分开）
        preload: path.join(__dirname, '../preload/dsh-view.js')
      }
    })
    this.win.contentView.addChildView(this.view)
    // 通知事件中枢 webview 通道（R-26：投递回执；投递前 hub 已剥离 actions）
    notificationHub.setWebview({
      deliver: (ev) => {
        const v = this.view
        if (!v || v.webContents.isDestroyed()) return false
        try {
          v.webContents.send('dsh-notify:event', ev)
          return true
        } catch {
          return false
        }
      }
    })
    // 页面 → 壳（作用域限定该 view，不污染 ipcMain 全局通道；R-27）
    this.view.webContents.on('ipc-message', (_event, channel, ...args) => {
      if (channel !== 'dsh-exo') return
      // 侧边栏「网页版 DeepSeek」入口的点击（注入按钮→ __dshExo.send）
      if (String(args[0]) === WEBPANEL_TOGGLE_CHANNEL) {
        this.toggleWebPanel()
        return
      }
      // 侧边栏底部「管理面板」入口（网页版/管理面板是底部工具栏里的两个壳入口）
      if (String(args[0]) === PANEL_OPEN_CHANNEL) {
        this.openPanelTab('overview')
        return
      }
      // DSH 主题切换（页面观察 body[data-ds-dark-theme] 后回壳）→ 跟随换叠加层底色
      if (String(args[0]) === THEME_CHANGED_CHANNEL) {
        const p = args[1] as { dark?: boolean } | undefined
        if (typeof p?.dark === 'boolean') this.dshDarkTheme = p.dark
        this.syncTitleBarOverlay()
        return
      }
      notificationHub.handleViewMessage(String(args[0]), args[1])
    })
    // 每次加载/重载开始时复位握手，等页面 __dshExo.ready() 重新握手。
    // 修复（实测日志证据）：原来用 did-finish-load 复位——插件 ready() 常在 load 之后才执行，
    // 会被 did-finish-load 覆盖成 false，导致 webview 长期离线、通知全降级原生。
    // 改用 did-start-loading：加载一开始就复位，页面 JS（含插件握手）在之后执行，
    // 顺序必然「先复位、后握手」，webview 在线状态稳定。
    this.view.webContents.on('did-start-loading', () => {
      notificationHub.markWebviewReady(false)
    })
    this.view.webContents.setWindowOpenHandler(({ url: u }) => {
      void shell.openExternal(u)
      return { action: 'deny' }
    })
    // 清除 HTTP 缓存：启动竞态下旧 index/旧 bundle rev 可能被缓存，导致刷新后仍请求已失效的 URL
    void this.view.webContents.session.clearCache().catch(() => {})
    // 内核每次重启（新端口/新 secret）都会产生新的 dsh-auth cookie，旧的不会自动清理，
    // 累积到请求头超过 node:http 16KB 上限会触发 431（Request Header Fields Too Large），
    // 导致插件 bundle 加载失败（浏览器无累积故正常）。保留最近 2 个、清掉更旧的。
    const viewSession = this.view.webContents.session
    void viewSession.cookies.get({ domain: '127.0.0.1' }).then((cookies) => {
      const auth = cookies
        .filter((c) => typeof c.name === 'string' && c.name.startsWith('dsh-auth-'))
        .sort((a, b) => (b.expirationDate ?? 0) - (a.expirationDate ?? 0))
      for (const c of auth.slice(2)) {
        void viewSession.cookies.remove(`http://${c.domain}${c.path ?? '/'}`, c.name).catch(() => {})
      }
      if (auth.length > 2) {
        // 正常维护动作（仅保留最近 2 个 dsh-auth cookie，防请求头超 16KB 上限），
        // 不是异常——记 INFO，避免总览「日志告警」被每次内核重启刷成假告警
        logger.info('dsh view stale auth cookies cleared', { cleared: auth.length - 2 })
      }
    }).catch(() => {})
    this.view.webContents.loadURL(url)
    // 加载完成（含自动重载）后：注入侧边栏入口 + 调度健康检查
    this.view.webContents.on('did-finish-load', () => {
      this.injectSidebarEntry()
      this.scheduleDshViewHealthCheck(DSH_VIEW_HEALTH_CHECK_MS)
    })
    // 主 frame 加载失败（如内核瞬时未就绪）也走健康检查重试；-3 = ERR_ABORTED 正常中断，忽略
    this.view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        logger.warn('dsh view main-frame load failed', { errorCode, errorDescription })
        this.scheduleDshViewHealthCheck(DSH_VIEW_HEALTH_CHECK_MS)
      }
    })
    // 管理面板打开时保持隐藏（服务重启重挂载后不打断面板）
    this.view.setVisible(!this.adminPanelVisible)
    // 焦点跟随：点击 DSH 页面时聚焦（保证输入可用）
    this.view.webContents.on('focus', () => this.view?.webContents.focus())
    this.layoutView()
    logger.info('dsh view attached', { url })
  }

  detachDshView(): void {
    this.clearDshViewTimers()
    this.dshViewRetryCount = 0
    if (this.view && this.win) {
      // 通知中枢 webview 通道下线（服务重启重挂载后自动重新注册）
      notificationHub.setWebview(null)
      this.win.contentView.removeChildView(this.view)
      this.view.webContents.close()
      this.view = null
      this.viewUrl = null
      logger.info('dsh view detached')
    }
  }

  /** 清理 DSH 视图的定时器 */
  private clearDshViewTimers(): void {
    if (this.dshViewHealthTimer) {
      clearTimeout(this.dshViewHealthTimer)
      this.dshViewHealthTimer = null
    }
  }

  /**
   * 轮询检测 DSH 页面是否卡在「Failed to load plugins」错误横幅，是则清缓存强制重载。
   * 启动竞态下 bundle rev 变化后旧页面请求 404，检测到错误后自动 reloadIgnoringCache 自愈。
   */
  private scheduleDshViewHealthCheck(delayMs: number): void {
    if (this.dshViewHealthTimer) clearTimeout(this.dshViewHealthTimer)
    this.dshViewHealthTimer = setTimeout(() => {
      this.dshViewHealthTimer = null
      const view = this.view
      if (!view || view.webContents.isDestroyed()) return
      view.webContents
        .executeJavaScript(`(async () => {
          try {
            const boot = globalThis.__DSH_BOOT__ || {}
            const urls = (Array.isArray(boot.batches) ? boot.batches : []).map(b => b.url).slice(0, 2)
            const statuses = []
            for (const u of urls) {
              try { const r = await fetch(u, { cache: 'no-store' }); statuses.push(String(r.status) + ':' + u.slice(0, 110)) }
              catch (e) { statuses.push('ERR:' + u.slice(0, 110)) }
            }
            const t = (document.body ? document.body.innerText : '') || ''
            return { failed: /failed to load plugins/i.test(t), snippet: t.slice(0, 220), url: location.href, statuses }
          } catch { return { failed: false, snippet: '', url: '', statuses: [] } }
        })()`)
        .then((r: unknown) => {
          const state = r as { failed?: boolean; snippet?: string; url?: string; statuses?: string[] }
          if (state?.failed !== true) {
            this.dshViewRetryCount = 0
            return
          }
          logger.warn('dsh view plugin-load check', {
            attempt: this.dshViewRetryCount + 1,
            url: state.url,
            snippet: state.snippet,
            statuses: state.statuses
          })
          if (this.dshViewRetryCount >= DSH_VIEW_RETRY_MAX) {
            logger.warn('dsh view plugin-load retry exhausted', { count: this.dshViewRetryCount })
            this.dshViewRetryCount = 0
            return
          }
          this.dshViewRetryCount += 1
          const delay = Math.min(2_000 + DSH_VIEW_HEALTH_CHECK_MS * this.dshViewRetryCount, 10_000)
          logger.warn('dsh view shows plugin load failure; reloading', { attempt: this.dshViewRetryCount, delayMs: delay })
          try {
            view.webContents.reloadIgnoringCache()
          } catch { /* 忽略 */ }
          this.scheduleDshViewHealthCheck(delay)
        })
        .catch(() => {})
    }, delayMs)
  }

  /**
   * 同步原生窗口按钮叠加层（titleBarOverlay）底色，消除右上角色缝。
   *
   * 为什么必须同步：`titleBarOverlay.color` 是**窗口级**的，而窗口内容区依次承载
   * 底色不同的表面——壳管理面板（#060B12）、DSH Web UI 顶栏（暗 #151517 / 亮 #FFFFFF）、
   * 官方网页版（站点自定）。固定一个色必然与其中若干表面错位。
   *
   * 调用时机：① 窗口创建（壳画布色）② DSH 视图挂载/取色成功 ③ 网页版视图显隐
   * ④ 管理面板显隐 ⑤ DSH 主题切换（页面经 __dshExo 回壳）。
   * 颜色经 normalizeCssColor 归一化，非法值直接忽略（保留上一次正确颜色）。
   */
  private applyTitleBarOverlay(color: unknown): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const normalized = normalizeCssColor(color)
    if (!normalized) return
    if (this.titleBarColor === normalized) return
    this.titleBarColor = normalized
    try {
      // Windows/Linux 支持运行时改；其他平台（macOS 用红绿灯）静默忽略
      win.setTitleBarOverlay({
        color: normalized,
        symbolColor: pickSymbolColor(normalized),
        height: TITLEBAR_OVERLAY_HEIGHT
      })
      logger.debug('titlebar overlay color synced', { color: normalized })
    } catch (err) {
      logger.debug('titlebar overlay sync skipped', err)
    }
  }

  /** 当前在上的表面决定叠加层底色：网页版 > 管理面板 > DSH Web UI */
  private currentSurface(): 'web' | 'admin' | 'dsh' {
    if (this.webPanelVisible) return 'web'
    if (this.adminPanelVisible) return 'admin'
    return 'dsh'
  }

  /**
   * 按当前在上的表面同步叠加层底色。
   * - 管理面板 → 壳画布色（固定暗色）
   * - DSH Web UI → 实测顶栏色，失败回退官方令牌兜底值（按当前主题取暗/亮）
   * - 网页版 → 取站点自身顶栏色，失败回退当前 DSH 主题色（中性深/浅，不会突兀）
   */
  private syncTitleBarOverlay(): void {
    const surface = this.currentSurface()
    if (surface === 'admin') {
      this.applyTitleBarOverlay(SHELL_CANVAS_COLOR)
      return
    }
    if (surface === 'web') {
      const fallback = this.dshDarkTheme ? DSH_TOP_COLOR_DARK : DSH_TOP_COLOR_LIGHT
      const view = this.webView
      if (!view || view.webContents.isDestroyed()) {
        this.applyTitleBarOverlay(fallback)
        return
      }
      this.probeWebTopColor(view.webContents, fallback)
      return
    }
    // DSH Web UI：先落兜底值（保证任何时刻都不是旧壳色），再异步用实测值纠正
    const fallback = this.dshDarkTheme ? DSH_TOP_COLOR_DARK : DSH_TOP_COLOR_LIGHT
    this.applyTitleBarOverlay(fallback)
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    this.probeDshTopColor(view.webContents)
  }

  /** 实测 DSH 顶栏色并应用；取不到就保持兜底色（并有限次重试，覆盖启动期页面未铺满） */
  private probeDshTopColor(wc: Electron.WebContents): void {
    wc.executeJavaScript(buildTopColorProbeScript(TITLEBAR_OVERLAY_HEIGHT))
      .then((r: unknown) => {
        const state = r as { color?: string | null; source?: string; dark?: boolean } | null
        if (typeof state?.dark === 'boolean') this.dshDarkTheme = state.dark
        const color = normalizeCssColor(state?.color)
        if (color) {
          this.topColorProbeAttempts = 0
          this.applyTitleBarOverlay(color)
          return
        }
        // 页面还在骨架/未铺满：有限次重试后保持兜底色。
        // 重试前重新确认「当前仍在 DSH 表面」——期间用户可能已切到管理面板/网页版，
        // 那时该由 syncTitleBarOverlay 决定底色，不能被迟到的重试覆盖。
        if (this.topColorProbeAttempts < DSH_TOPBAR_PROBE_MAX) {
          this.topColorProbeAttempts += 1
          setTimeout(() => {
            const v = this.view
            if (!v || v.webContents.isDestroyed()) return
            if (this.currentSurface() !== 'dsh') return
            this.probeDshTopColor(v.webContents)
          }, 700)
        }
      })
      .catch(() => { /* 页面不可达：保留兜底色 */ })
  }

  /** 实测网页版站点顶栏色并应用（登录页/深色站点都能自适应），取不到保持兜底色 */
  private probeWebTopColor(wc: Electron.WebContents, fallback: string): void {
    wc.executeJavaScript(buildTopColorProbeScript(TITLEBAR_OVERLAY_HEIGHT))
      .then((r: unknown) => {
        const state = r as { color?: string | null } | null
        this.applyTitleBarOverlay(normalizeCssColor(state?.color) ?? fallback)
      })
      .catch(() => this.applyTitleBarOverlay(fallback))
  }

  private layoutView(): void {
    const win = this.win
    if (!win) return
    const [w, h] = win.getContentSize()
    // 无系统标题栏（titleBarOverlay）→ 内容区从 y=0 铺满：
    // 顶部那一行即 DSH 自己的侧边栏品牌行，右上角由原生窗口按钮叠加覆盖
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setBounds({ x: 0, y: 0, width: w, height: h })
    }
    // 网页版视图：贴在 DSH 侧边栏右侧（侧边栏仍可见，便于点入口收起）
    if (this.webView && !this.webView.webContents.isDestroyed()) {
      const x = Math.min(this.sidebarWidth, w)
      this.webView.setBounds({ x, y: 0, width: Math.max(0, w - x), height: h })
    }
  }

  /**
   * 注入侧边栏「网页版 DeepSeek」入口（幂等，页面重载后重新注入）。
   * 同时实测侧边栏宽度，供网页版视图定位。
   */
  private injectSidebarEntry(): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    // 顶部拖拽区（无系统标题栏）：CSS 负责 logoRow 与会话态 header，脚本负责空态拖拽条
    void view.webContents
      .insertCSS(buildTopDragRegionCss(TITLEBAR_OVERLAY_HEIGHT), { cssOrigin: 'user' })
      .catch((err) => logger.debug('drag region css skipped', err))
    void view.webContents
      .executeJavaScript(buildTopDragStripScript(TITLEBAR_OVERLAY_HEIGHT, WINDOW_CONTROLS_CLUSTER_WIDTH, DEFAULT_SIDEBAR_WIDTH))
      .catch((err) => logger.debug('drag strip inject skipped', err))
    view.webContents.executeJavaScript(buildSidebarEntryScript()).catch((err) => {
      logger.debug('sidebar entry inject skipped', err)
    })
    // 底部工具栏：把官方底部区（设置行 + 插槽行）重排成一行 4 个小按钮（详见 web-sidebar-entry）
    view.webContents.executeJavaScript(buildSidebarFooterScript()).catch((err) => {
      logger.debug('sidebar footer inject skipped', err)
    })
    // 主题观察：DSH 换主题只改 body 属性、不发事件，注入观察器回壳换叠加层底色
    view.webContents.executeJavaScript(buildThemeWatchScript()).catch((err) => {
      logger.debug('theme watch inject skipped', err)
    })
    // 顶栏底色与叠加层对齐（右上角三个原生按钮底下的颜色）
    this.syncTitleBarOverlay()
    view.webContents
      .executeJavaScript(measureSidebarWidthScript())
      .then((w: unknown) => {
        if (typeof w === 'number' && w > 100 && w < 600) {
          if (Math.abs(w - this.sidebarWidth) > 1) {
            this.sidebarWidth = w
            this.layoutView()
            logger.info('sidebar width measured', { width: w })
          }
        }
      })
      .catch(() => {})
    // 底部工具栏的宽/窄态重排（侧边栏折叠切换时 footer 布局要跟着切）
    this.syncSidebarFooter()
  }

  /**
   * 重新同步侧边栏底部工具栏（侧边栏折叠/展开、窗口几何变化后由壳主动推）。
   *
   * 为什么壳侧要推：页面内已有 MutationObserver，但侧边栏折叠只改布局宽度
   * （不改 class、不增删节点，实测见 verify-drag-region 的同类结论），
   * childList 观察器看不到，必须显式同步一次宽/窄态标记。
   */
  syncSidebarFooter(): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    void view.webContents
      .executeJavaScript(`(() => { try { return window.__dshExoFootSync ? window.__dshExoFootSync() : 'no-sync' } catch { return 'error' } })()`)
      .catch((err) => logger.debug('sidebar footer sync skipped', err))
  }

  /**
   * 重新同步空态顶部拖拽条（壳在窗口几何变化后调用）。
   *
   * 为什么壳侧要主动推：侧边栏折叠/展开、窗口缩放都可能改变拖拽条应占的横向范围，
   * 页面内虽已接了 ResizeObserver + resize，但窗口被最大化/还原时 DSH 未必收到 resize
   * （WebContentsView 尺寸由 layoutView 设定），叠一次显式同步最稳。
   */
  syncDragStrip(): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    void view.webContents
      .executeJavaScript(`(() => { try { return window.__dshExoDragStripSync ? window.__dshExoDragStripSync() : 'no-sync' } catch { return 'error' } })()`)
      .catch((err) => logger.debug('drag strip sync skipped', err))
  }

  /** 侧边栏入口点击：切网页版视图显隐（点击入口本身即切换） */
  toggleWebPanel(): void {
    this.setWebPanelVisible(!this.webPanelVisible)
  }

  getViewUrl(): string | null {
    return this.viewUrl
  }

  /** 显示/隐藏管理面板：打开时隐藏 DSH Web UI 视图，关闭时恢复显示 */
  setAdminPanelVisible(visible: boolean): void {
    this.adminPanelVisible = visible
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(!visible)
      if (!visible) {
        this.view.webContents.focus()
      }
    }
    // 管理面板打开时收起网页版视图（两者共用主内容区，避免叠层）
    if (visible) this.setWebPanelVisible(false)
    // 表面切换 → 叠加层底色跟随（面板=壳画布色，DSH=顶栏实测色）
    this.syncTitleBarOverlay()
    logger.info('admin panel visibility', { visible, hasDshView: !!this.view, hasWebView: !!this.webView })
  }

  /**
   * 显示/隐藏官方网页版 DeepSeek（入口：DSH Web UI 左侧边栏注入按钮）。
   * 懒创建独立 WebContentsView（持久化分区，登录态落盘保留），
   * 贴在侧边栏右侧，并回写按钮选中态。
   */
  setWebPanelVisible(visible: boolean): void {
    this.webPanelVisible = visible
    if (!this.win) return
    if (visible) {
      // 网页版与 DSH 视图争主内容区：先确认 DSH 视图在显示（管理面板关闭态）
      if (this.adminPanelVisible) this.setAdminPanelVisible(false)
      const view = this.ensureWebView()
      view.setVisible(true)
      this.layoutView()
      view.webContents.focus()
    } else if (this.webView && !this.webView.webContents.isDestroyed()) {
      this.webView.setVisible(false)
      this.view?.webContents.focus()
    }
    this.view?.webContents
      .executeJavaScript(setSidebarEntryActiveScript(visible))
      .catch(() => {})
    // 表面切换 → 叠加层底色跟随（网页版=站点顶栏色，DSH=顶栏实测色）
    this.syncTitleBarOverlay()
    logger.info('web panel visibility', { visible, hasWebView: !!this.webView })
  }

  /** 主进程侧（托盘等）打开管理面板并定位到指定标签，同时同步渲染层面板状态 */
  openPanelTab(tab: DashboardTab): void {
    this.show()
    this.setWebPanelVisible(false)
    this.setAdminPanelVisible(true)
    this.win?.webContents.send('panel:open', tab)
  }

  /** 懒创建官方网页版 DeepSeek 视图（独立 WebContentsView，仅创建一次，后续显示/隐藏复用） */
  private ensureWebView(): WebContentsView {
    if (this.webView && !this.webView.webContents.isDestroyed()) return this.webView
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
        // 持久化分区：cookie/localStorage 落盘，重启后官方网页版登录态保留
        partition: 'persist:deepseek-web'
      }
    })
    this.webView = view
    this.win?.contentView.addChildView(view)
    view.setVisible(false)
    // 站内新窗口在当前视图内导航（登录弹窗等）；外链交给系统浏览器
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(DEEPSEEK_WEB_URL)) {
        void view.webContents.loadURL(url)
      } else {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    // 主 frame 加载失败记录（断网等）；-3 = ERR_ABORTED 正常中断，忽略
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        logger.warn('deepseek web view load failed', { errorCode, errorDescription })
      }
    })
    // 站点加载/站内导航完成后重新取顶栏色（登录页与主界面底色可能不同）
    view.webContents.on('did-finish-load', () => {
      if (this.webPanelVisible) this.syncTitleBarOverlay()
    })
    view.webContents.loadURL(DEEPSEEK_WEB_URL)
    this.layoutView()
    logger.info('deepseek web view created', { url: DEEPSEEK_WEB_URL })
    return view
  }

  /** 销毁网页版视图（应用退出时释放） */
  private destroyWebView(): void {
    if (this.webView && this.win) {
      this.win.contentView.removeChildView(this.webView)
      this.webView.webContents.close()
      this.webView = null
      this.webPanelVisible = false
      logger.info('deepseek web view destroyed')
    }
  }

  /** 窗口是否对用户激活（前台焦点、未开管理面板、未开网页版）——通知 auto 路由与会话抑制共用 */
  isWindowActive(): boolean {
    const w = this.win
    // 网页版视图显示时 DSH Web UI 被它遮住，此时 webview 通道的 toast 用户也看不到，
    // 故按「未激活」处理，让通知降级为原生 toast 再点回跳。
    return !!w && !w.isDestroyed() && w.isFocused() && !this.adminPanelVisible && !this.webPanelVisible
  }

  /**
   * 读取 DSH Web UI 当前选中会话的 uuid（壳侧会话感知抑制用，不依赖插件）。
   * 复用 activateSessionInWebUi 的 React fiber 读取：取选中行
   * [aria-selected]/[class*="selected"] 的 __reactFiber$ 向上找 memoizedProps.node.id，
   * 归一化去掉 session- 前缀；读不到返回 null（调用方回退为不抑制，宁可多弹不漏报）。
   */
  async getActiveSessionId(): Promise<string | null> {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return null
    const script = `(() => {
      const readId = (el) => {
        const k = el && Object.keys(el).find(x => x.startsWith('__reactFiber'));
        if (!k) return null;
        let f = el[k];
        for (let i = 0; i < 8 && f; i++) {
          const p = f.memoizedProps;
          if (p && p.node && typeof p.node.id === 'string' && p.node.id) return p.node.id;
          f = f.return;
        }
        return null;
      };
      const sels = [...document.querySelectorAll('[class*="sessionRow"][aria-selected="true"], [class*="sessionRow"][class*="selected"]')];
      if (sels.length === 0) return null;
      const id = readId(sels[sels.length - 1]);
      return id ? id.replace(/^session-/, '') : null;
    })()`
    try {
      const r = await view.webContents.executeJavaScript(script)
      return typeof r === 'string' && r ? r : null
    } catch (err) {
      logger.debug('read active session failed', err)
      return null
    }
  }

  /**
   * 在 DSH Web UI 中定位并激活对应会话（增强版）。
   * 流程：1) 尝试展开折叠的工作区分组 → 2) 按会话 ID 精确匹配（从 React fiber 读取
   *      node.id，优先于文本）→ 3) 无 ID 或未命中时按标题匹配 [class*="sessionRow"]/treeitem
   *      → 4) 时间兜底（最近完成）→ 5) 验证选中态是否切换为目标会话，未切换则重试（最多 4 轮）。
   * 依据实际勘察：会话列表 DOM 无 data 属性，但 React 组件节点携带 node.id（会话 uuid），
   * 可通过元素上的 __reactFiber$ 属性读取；读取失败时静默回退标题匹配。
   * SPA 结构变化时静默失败（不影响唤起主窗口）。
   */
  activateSessionInWebUi(title: string, altText?: string, sessionId?: string): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    const targets = [title, altText].filter((s): s is string => !!s).map((s) => s.slice(0, 40))

    const attempt = (n: number): void => {
      if (n > 3 || view.webContents.isDestroyed()) {
        logger.debug('webui session activate exhausted', { n })
        return
      }
      const script = `(() => {
        try {
          // 1) 展开折叠的会话分组（文本含"展开/其余 N 个会话/expand"的按钮/树项）
          document.querySelectorAll('[role="button"], [role="treeitem"], [class*="expand"]').forEach(el => {
            const t = (el.textContent || '').trim();
            if (t && t.length < 40 && /展开|其余\s*\d+\s*个会话|show more|expand/i.test(t)) el.click();
          });
          // 从 React fiber 读取会话 ID（组件 props.node.id，向上遍历最多 8 层）
          const readId = (el) => {
            const k = Object.keys(el).find(x => x.startsWith('__reactFiber'));
            if (!k) return null;
            let f = el[k];
            for (let i = 0; i < 8 && f; i++) {
              const p = f.memoizedProps;
              if (p && p.node && typeof p.node.id === 'string' && p.node.id) return p.node.id;
              f = f.return;
            }
            return null;
          };
          // 归一化：DSH SessionId 形如 "session-<uuid>"，目录名提取的 uuid 无前缀——比较时统一去前缀
          const norm = (s) => (typeof s === 'string' ? s.replace(/^session-/, '') : s);
          const items = [...document.querySelectorAll('[class*="sessionRow"], [role="treeitem"]')];
          // 2) 会话 ID 精确匹配（优先，消除同标题误点）
          const targetId = ${JSON.stringify(sessionId ?? '')};
          if (targetId) {
            const want = norm(targetId);
            for (const el of items) {
              const id = readId(el);
              if (id && norm(id) === want) { el.click(); return 1; }
            }
          }
          // 3) 标题匹配并点击
          const targets = ${JSON.stringify(targets)};
          let hit = null;
          for (const el of items) {
            const txt = (el.textContent || '').trim();
            if (!txt || txt.length > 300) continue;
            const lower = txt.toLowerCase();
            if (targets.some(tg => tg && lower.includes(tg.toLowerCase()))) hit = el;
          }
          // 4) 时间兜底：候选全不中时，点击"刚刚/N秒前/N分钟前"结尾的会话叶子（最近完成的）
          if (!hit) {
            const timeRe = /刚刚|秒前|分钟前|小时前|昨天|天前/i;
            for (const el of items) {
              const txt = (el.textContent || '').trim();
              if (!txt || txt.length > 300) continue;
              if (timeRe.test(txt) && !/展开|其余|工作区|未分组|进行中/i.test(txt)) { hit = el; break; }
            }
          }
          if (hit) { hit.click(); return 1; }
          return 0;
        } catch { return -1; }
      })()`
      view.webContents
        .executeJavaScript(script)
        .then(async (clicked: unknown) => {
          if (clicked !== 1) {
            // 展开后也需重试（分组渲染异步）
            setTimeout(() => attempt(n + 1), 1_200)
            return
          }
          // 3) 验证选中态是否已切换为目标会话
          await new Promise((r) => setTimeout(r, 1_400))
          const verifyScript = `(() => {
            const readId = (el) => {
              const k = Object.keys(el).find(x => x.startsWith('__reactFiber'));
              if (!k) return null;
              let f = el[k];
              for (let i = 0; i < 8 && f; i++) {
                const p = f.memoizedProps;
                if (p && p.node && typeof p.node.id === 'string' && p.node.id) return p.node.id;
                f = f.return;
              }
              return null;
            };
            const norm = (s) => (typeof s === 'string' ? s.replace(/^session-/, '') : s);
            const sels = [...document.querySelectorAll('[class*="sessionRow"][aria-selected="true"], [class*="sessionRow"][class*="selected"]')];
            if (sels.length === 0) return 2;
            const last = sels[sels.length - 1];
            // ID 精确验证（优先，归一化比较）
            const targetId = ${JSON.stringify(sessionId ?? '')};
            if (targetId && norm(readId(last)) === norm(targetId)) return 1;
            const txt = last.textContent.trim().slice(0, 60).toLowerCase();
            const targets = ${JSON.stringify(targets.map((t) => t.toLowerCase()))};
            if (targets.some((tg) => tg && txt.includes(tg))) return 1;
            // 时间兜底候选也接受：选中项是"刚刚/N秒前"叶子即认为已切换
            if (/刚刚|秒前|分钟前/.test(txt) && !/工作区|未分组/.test(txt)) return 1;
            return 0;
          })()`
          const ok = await view.webContents.executeJavaScript(verifyScript)
          if (ok !== 1) setTimeout(() => attempt(n + 1), 1_200)
        })
        .catch(() => logger.debug('webui session activate skipped'))
    }

    // 等待窗口显示与 SPA 渲染后开始
    setTimeout(() => attempt(0), 800)
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    if (process.platform === 'win32') {
      // Windows 前台锁对策（修复：点击通知/协议激活后窗口不置顶）——
      // focus() 受 SetForegroundWindow 限制（后台激活的应用拿不到前台权）不会抬到最前。
      // 正确姿势：先 setAlwaysOnTop(true) 强制 topmost → moveTop/focus 抬升 →
      // 保持一小段时间再撤销（旧实现 setTimeout(0) 里置顶/撤销被合并成一次 no-op，
      // 实测失效）。撤销前窗口短暂置顶约 250ms，肉眼几乎无感。
      // 若用户本就设置了置顶（isAlwaysOnTop 已 true），不再抖动以免误改状态。
      try {
        if (this.win.isAlwaysOnTop()) {
          this.win.moveTop()
          this.win.focus()
        } else {
          this.win.setAlwaysOnTop(true)
          this.win.moveTop()
          this.win.focus()
          setTimeout(() => {
            if (this.win && !this.win.isDestroyed()) this.win.setAlwaysOnTop(false)
          }, 250)
        }
      } catch (err) {
        logger.warn('window force-front failed', err)
      }
    } else {
      this.win.focus()
    }
    logger.debug('window show called', {})
  }

  hide(): void {
    this.win?.hide()
  }

  /** 侧边栏入口点击：切网页版视图显隐（点击入口本身即切换） */
  broadcast(channel: string, ...args: unknown[]): void {
    this.win?.webContents.send(channel, ...args)
  }

  /** 应用退出：允许真正关闭窗口 */
  quit(): void {
    this.isQuitting = true
    // 退出前刷新几何（防抖可能尚未触发）
    if (this.geometryTimer) {
      clearTimeout(this.geometryTimer)
      this.geometryTimer = null
      this.persistGeometry()
    }
    // R-16: 同步落盘（persist 已改异步防抖，退出前必须 flush 保证最后一次写入不丢）
    configStore.flush()
    this.detachDshView()
    this.destroyWebView()
    app.quit()
  }
}

export const windowManager = new WindowManager()
