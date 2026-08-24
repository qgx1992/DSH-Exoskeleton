/**
 * 自动更新（文档 §4.3.1）
 * - 打包版（NSIS）：electron-updater + GitHub Releases，后台静默下载 → 通知 → 一键重启安装
 * - 开发版/便携版：检查 GitHub 最新 Release，引导手动下载替换
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { EventEmitter } from 'node:events'
import { logger } from './logger'
import { windowManager } from './window-manager'
import { notify } from './notify'
import type { UpdateInfo } from '../shared/types'

const REPO = 'qgx1992/DSH-Exoskeleton'
const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`

class Updater extends EventEmitter {
  private cache: UpdateInfo | null = null
  private installing = false
  private initialized = false

  /** 仅打包版初始化 electron-updater */
  init(): void {
    if (!app.isPackaged || this.initialized) return
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
      this.emitStatus()
    })
    autoUpdater.on('update-downloaded', (info) => {
      logger.info('update downloaded', { version: info.version })
      notify(
        'DSH-Exoskeleton 更新已就绪',
        `新版本 v${info.version} 已下载完成，点击重启安装。`,
        () => this.install()
      )
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

    if (app.isPackaged) {
      const base = this.base()
      try {
        const result = await autoUpdater.checkForUpdates()
        const version = result?.updateInfo?.version
        base.latest = version ?? null
        base.available = !!version && version !== app.getVersion()
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

    // 开发版：GitHub API 占位（便携版同样提示手动下载）
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

  /** 安装更新：打包版调 quitAndInstall；开发/便携版打开下载页 */
  install(): void {
    if (this.installing) return
    if (app.isPackaged) {
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

  private needsUpdate(current: string, latest: string): boolean {
    const cv = this.parseVersion(current)
    const lv = this.parseVersion(latest)
    if (!cv || !lv) return false
    return lv > cv
  }

  private parseVersion(v: string): number[] | null {
    const m = v.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!m) return null
    return [Number(m[1]), Number(m[2]), Number(m[3])]
  }
}

export const updater = new Updater()