/**
 * 自动更新（文档 §4.3.1，MVP 为版本检查占位）
 * 安装版（NSIS）后续接入 electron-updater + GitHub Releases 静默下载；
 * 便携版仅提示手动下载。
 */
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { logger } from './logger'
import type { UpdateInfo } from '../shared/types'

const REPO = 'deepseek-ai/deepseek-harness'
const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`

class Updater extends EventEmitter {
  private cache: UpdateInfo | null = null

  async check(force = false): Promise<UpdateInfo> {
    if (this.cache && !force) return this.cache
    const current = app.getVersion()
    const base: UpdateInfo = {
      current,
      latest: null,
      available: false,
      url: null,
      checkedAt: Date.now(),
      error: null
    }
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
      base.url = data.html_url ?? `https://github.com/${REPO}/releases/latest`
      // 桌面端版本号与 DSH 内核版本独立：内核版本由 dsh --version 提供
      base.available = !!(latest && this.needsUpdate(current, latest))
      logger.info('update check done', { current, latest })
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err)
      logger.warn('update check failed', base.error)
    }
    this.cache = base
    this.emit('status', base)
    return base
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