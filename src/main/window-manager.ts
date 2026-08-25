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

const TITLEBAR_HEIGHT = 36
const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800
const MIN_WIDTH = 900
const MIN_HEIGHT = 600
/** 几何保存防抖（ms） */
const GEOMETRY_DEBOUNCE_MS = 500

export class WindowManager {
  private win: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private viewUrl: string | null = null
  private isQuitting = false
  private geometryTimer: NodeJS.Timeout | null = null
  /** 管理面板是否打开（打开时隐藏 DSH Web UI 视图） */
  private adminPanelVisible = false

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
        spellcheck: false
      }
    })
    this.win.contentView.addChildView(this.view)
    this.view.webContents.setWindowOpenHandler(({ url: u }) => {
      void shell.openExternal(u)
      return { action: 'deny' }
    })
    this.view.webContents.loadURL(url)
    // 管理面板打开时保持隐藏（服务重启重挂载后不打断面板）
    this.view.setVisible(!this.adminPanelVisible)
    // 焦点跟随：点击 DSH 页面时聚焦（保证输入可用）
    this.view.webContents.on('focus', () => this.view?.webContents.focus())
    this.layoutView()
    logger.info('dsh view attached', { url })
  }

  detachDshView(): void {
    if (this.view && this.win) {
      this.win.contentView.removeChildView(this.view)
      this.view.webContents.close()
      this.view = null
      this.viewUrl = null
      logger.info('dsh view detached')
    }
  }

  private layoutView(): void {
    const win = this.win
    const view = this.view
    if (!win || !view) return
    const [w, h] = win.getContentSize()
    const y = process.env.ELECTRON_RENDERER_URL ? TITLEBAR_HEIGHT : TITLEBAR_HEIGHT
    view.setBounds({ x: 0, y, width: w, height: Math.max(0, h - y) })
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
      logger.info('admin panel visibility', { visible, hasDshView: true })
    } else {
      logger.info('admin panel visibility', { visible, hasDshView: false })
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
    if (!this.win) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    this.win.focus()
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
    this.detachDshView()
    app.quit()
  }
}

export const windowManager = new WindowManager()