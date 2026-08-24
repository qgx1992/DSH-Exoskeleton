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