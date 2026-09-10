/**
 * 自动更新（文档 §4.3.1）
 * - 打包版（NSIS）：electron-updater + GitHub Releases，后台静默下载 → 通知 → 一键重启安装
 * - 开发版/便携版：检查 GitHub 最新 Release，引导手动下载替换
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'
import { windowManager } from './window-manager'
import { notificationHub } from './notification-hub'
import { compareVersions } from '../shared/version'
import type { UpdateInfo } from '../shared/types'

const REPO = 'qgx1992/DSH-Exoskeleton'
const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`

class Updater extends EventEmitter {
  private cache: UpdateInfo | null = null
  private installing = false
  private initialized = false
  /** R-19: 进度广播节流（下载进度事件可能每秒数十次，避免高频 IPC） */
  private lastProgressEmit = 0

  /**
   * 便携版：electron-builder 在运行时注入 PORTABLE_EXECUTABLE_DIR。
   * 注意便携版的 app.isPackaged 同样为 true，但 exe 无法被 electron-updater 就地替换
   * （上游不支持 portable 目标）——必须与开发版一样走「跳转下载页」分支，
   * 否则用户点「立即重启安装」会调 quitAndInstall 而行为未定义。
   */
  private get isPortable(): boolean {
    return !!process.env.PORTABLE_EXECUTABLE_DIR
  }

  /** 能不能走 electron-updater 静默更新：仅安装版（NSIS）支持 */
  private get canAutoUpdate(): boolean {
    return app.isPackaged && !this.isPortable
  }

  /** 仅安装版初始化 electron-updater */
  init(): void {
    if (!this.canAutoUpdate) {
      // 便携版/开发版：没有可用的静默更新通道，记一条供日志页排查
      if (this.isPortable) logger.info('updater: 便携版（PORTABLE_EXECUTABLE_DIR）→ 走下载页引导，不启用 electron-updater')
      return
    }
    if (this.initialized) return
    this.initialized = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = {
      info: (m: string) => logger.debug('[autoUpdater]', m),
      warn: (m: string) => logger.warn('[autoUpdater]', m),
      error: (m: string) => logger.error('[autoUpdater]', m),
      debug: (m: string) => logger.debug('[autoUpdater]', m)
    }
    autoUpdater.on('checking-for-update', () => {
      this.emitStatus()
    })
    autoUpdater.on('update-available', (info) => {
      logger.info('update available', { version: info.version })
      this.emitStatus()
    })
    autoUpdater.on('update-not-available', () => {
      logger.info('update not available')
      this.emitStatus()
    })
    autoUpdater.on('download-progress', (p) => {
      this.cache = {
        ...this.base(),
        latest: this.cache?.latest ?? null,
        available: true,
        progress: { percent: Math.round(p.percent * 10) / 10, transferred: p.transferred, total: p.total },
        url: RELEASES_URL
      }
      // R-19: 250ms 节流广播（进度回调频率可达每秒数十次）
      const now = Date.now()
      if (now - this.lastProgressEmit >= 250) {
        this.lastProgressEmit = now
        this.emitStatus()
      }
    })
    autoUpdater.on('update-downloaded', (info) => {
      logger.info('update downloaded', { version: info.version })
      // 设计 §4.2：通知改走事件中枢（native/webview 由 hub 路由，点击一致触发安装）
      notificationHub.dispatch({
        id: randomUUID(),
        kind: 'update-ready',
        title: 'DSH-Exoskeleton 更新已就绪',
        body: `新版本 v${info.version} 已下载完成，点击重启安装。`,
        ts: Date.now(),
        update: { version: info.version },
        actions: { onClick: () => this.install() }
      })
      this.cache = {
        ...this.base(),
        latest: this.cache?.latest ?? info.version,
        available: true,
        downloaded: true,
        url: RELEASES_URL
      }
      windowManager.show()
      this.emitStatus()
    })
    autoUpdater.on('error', (err) => {
      logger.warn('autoUpdater error', err.message)
      this.cache = { ...this.base(), error: err.message }
      this.emitStatus()
    })
  }

  private base(): UpdateInfo {
    return {
      current: app.getVersion(),
      latest: null,
      available: false,
      url: null,
      checkedAt: null,
      error: null,
      progress: null,
      downloaded: false,
      installing: false
    }
  }

  private emitStatus(): void {
    if (!this.cache) this.cache = this.base()
    this.emit('status', { ...this.cache })
  }

  async check(force = false): Promise<UpdateInfo> {
    if (this.cache && !force && !this.cache.error) return this.cache
    this.init()

    if (this.canAutoUpdate) {
      const base = this.base()
      try {
        const result = await autoUpdater.checkForUpdates()
        const version = result?.updateInfo?.version
        base.latest = version ?? null
        base.available = !!version && this.needsUpdate(base.current, version)
        base.url = RELEASES_URL
        base.checkedAt = Date.now()
        logger.info('update check done (electron-updater)', { current: base.current, latest: version })
      } catch (err) {
        base.error = err instanceof Error ? err.message : String(err)
        logger.warn('update check failed (electron-updater)', base.error)
      }
      this.cache = base
      this.emitStatus()
      return base
    }

    // 开发版 / 便携版：GitHub API 查最新 Release，引导手动下载替换
    const base = this.base()
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10_000)
      const res = await fetch(GITHUB_API, {
        headers: { 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json' },
        signal: ctrl.signal
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`GitHub API ${res.status}`)
      const data = (await res.json()) as { tag_name?: string; html_url?: string }
      const latest = data.tag_name?.replace(/^v/, '') ?? null
      base.latest = latest
      base.url = data.html_url ?? RELEASES_URL
      base.available = !!latest && this.needsUpdate(base.current, latest)
      base.checkedAt = Date.now()
      logger.info('update check done (github api)', { current: base.current, latest })
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err)
      logger.warn('update check failed (github api)', base.error)
    }
    this.cache = base
    this.emitStatus()
    return base
  }

  /** 安装更新：安装版调 quitAndInstall；便携版/开发版打开下载页 */
  install(): void {
    if (this.installing) return
    if (this.canAutoUpdate) {
      this.installing = true
      this.cache = { ...(this.cache ?? this.base()), installing: true }
      this.emitStatus()
      autoUpdater.quitAndInstall()
      return
    }
    // 便携版/开发版：引导手动下载
    void import('electron').then(({ shell }) => {
      void shell.openExternal(this.cache?.url ?? RELEASES_URL)
    })
  }

  /**
   * 版本比较：统一走 shared/version 的 compareVersions（支持 -rc.N / -beta.N 预发布后缀）。
   * 旧实现只取 x.y.z 数字段 → 0.9.2-beta.1 与 0.9.2 被判为相等，
   * 结果 beta 测试用户收不到「回正式版」的升级提示。
   */
  private needsUpdate(current: string, latest: string): boolean {
    if (!current || !latest) return false
    return compareVersions(latest, current) > 0
  }
}

export const updater = new Updater()
