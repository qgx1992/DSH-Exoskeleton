/**
 * 窗口管理（文档 §4.1.2）
 * - 无边框窗口 + 自绘标题栏（renderer）
 * - DSH Web UI 以 WebContentsView 嵌入标题栏下方
 * - 单实例、关闭隐藏到托盘
 */
import { BrowserWindow, WebContentsView, app, shell, screen } from 'electron'
import path from 'node:path'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import { configStore } from './config'
import { notificationHub } from './notification-hub'

const TITLEBAR_HEIGHT = 36
/** 管理面板左侧导航宽度（对应 renderer w-44 = 11rem = 176px），网页版视图从它右侧开始 */
const NAV_WIDTH = 176
/** 官方网页版 DeepSeek（管理面板「网页版」标签，独立 WebContentsView 承载） */
const DEEPSEEK_WEB_URL = 'https://chat.deepseek.com'
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

export class WindowManager {
  private win: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private viewUrl: string | null = null
  private isQuitting = false
  private geometryTimer: NodeJS.Timeout | null = null
  /** 管理面板是否打开（打开时隐藏 DSH Web UI 视图） */
  private adminPanelVisible = false
  /** 「网页版 DeepSeek」原生视图（独立 WebContentsView，懒创建；管理面板内显示） */
  private webView: WebContentsView | null = null
  /** 网页版视图是否显示（管理面板打开且「网页版」标签激活） */
  private webPanelVisible = false
  /** DSH 页面插件加载失败的自动重载计数与定时器（启动竞态自愈） */
  private dshViewRetryCount = 0
  private dshViewHealthTimer: NodeJS.Timeout | null = null

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
      frame: false,
      title: 'DSH-Exoskeleton',
      backgroundColor: '#0b0f17',
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
    this.win.on('maximize', () => {
      this.win?.webContents.send('window:maximizeChange', true)
      this.persistGeometry()
    })
    this.win.on('unmaximize', () => {
      this.win?.webContents.send('window:maximizeChange', false)
      this.schedulePersist()
    })
    this.win.on('resize', () => {
      this.layoutView()
      this.schedulePersist()
    })
    this.win.on('move', () => this.schedulePersist())
    this.win.once('ready-to-show', () => {
      this.win?.show()
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

    // 状态变化时通知 renderer（仪表盘/标题栏状态点）
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

  /** 在标题栏下方区域挂载 DSH Web UI */
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
        logger.warn('dsh view stale auth cookies cleared', { cleared: auth.length - 2 })
      }
    }).catch(() => {})
    this.view.webContents.loadURL(url)
    // 加载完成（含自动重载）后调度健康检查
    this.view.webContents.on('did-finish-load', () => {
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

  private layoutView(): void {
    const win = this.win
    if (!win) return
    const [w, h] = win.getContentSize()
    const y = TITLEBAR_HEIGHT
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setBounds({ x: 0, y, width: w, height: Math.max(0, h - y) })
    }
    // 网页版视图：从左侧导航栏右侧开始（管理面板打开时布局，隐藏时 setVisible(false) 已不占交互）
    if (this.webView && !this.webView.webContents.isDestroyed()) {
      this.webView.setBounds({ x: NAV_WIDTH, y, width: Math.max(0, w - NAV_WIDTH), height: Math.max(0, h - y) })
    }
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
    // 网页版视图跟随面板：面板关闭必隐藏（DSH 视图恢复全屏覆盖），打开时按「网页版」标签状态恢复
    if (this.webView && !this.webView.webContents.isDestroyed()) {
      this.webView.setVisible(visible && this.webPanelVisible)
    }
    logger.info('admin panel visibility', { visible, hasDshView: !!this.view, hasWebView: !!this.webView })
  }

  /**
   * 管理面板「网页版」标签：显示/隐藏官方网页版 DeepSeek。
   * 懒创建独立 WebContentsView（持久化 session 分区，登录态落盘保留），
   * 从左侧导航栏右侧开始布局，保证面板标签可随时切换。
   */
  setWebPanelVisible(visible: boolean): void {
    this.webPanelVisible = visible
    if (!this.win) return
    if (visible) {
      const view = this.ensureWebView()
      view.setVisible(true)
      this.layoutView()
      view.webContents.focus()
    } else if (this.webView && !this.webView.webContents.isDestroyed()) {
      this.webView.setVisible(false)
    }
    logger.info('web panel visibility', { visible, hasWebView: !!this.webView })
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

  /** 窗口是否对用户激活（前台焦点且未打开管理面板）——通知 auto 路由与会话抑制共用 */
  isWindowActive(): boolean {
    const w = this.win
    return !!w && !w.isDestroyed() && w.isFocused() && !this.adminPanelVisible
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

  toggleMaximize(): void {
    if (!this.win) return
    if (this.win.isMaximized()) this.win.unmaximize()
    else this.win.maximize()
  }

  isMaximized(): boolean {
    return this.win?.isMaximized() ?? false
  }

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
