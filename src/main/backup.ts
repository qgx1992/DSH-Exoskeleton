/**
 * 备份与回滚（文档 §4.3.4）
 * - 手动存档 + 自动快照（插件安装/卸载、自动更新前）
 * - 一键回退到指定快照（恢复前自动再拍快照保护）
 * - 快照存储于 userData/backups/
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import type { BackupInfo } from '../shared/types'

const MAX_BACKUPS = 15

/** 排除的路径段（避免体积爆炸/临时文件） */
const EXCLUDED_SEGMENTS = ['node_modules', '.git', '__pycache__', '.DS_Store']
const EXCLUDED_EXTS = ['.db-wal', '.db-shm', '.tmp']

interface BackupMeta {
  name: string
  createdAt: number
  kind: 'manual' | 'auto'
  trigger: string
}

class BackupManager {
  private backupDir = ''
  private autoTimer: NodeJS.Timeout | null = null

  init(): void {
    this.backupDir = path.join(app.getPath('userData'), 'backups')
    fs.mkdirSync(this.backupDir, { recursive: true })
  }

  /** 定时自动备份调度（由配置变化/启动时调用） */
  syncAutoBackup(enabled: boolean, intervalHours: number): void {
    this.init()
    if (this.autoTimer) {
      clearInterval(this.autoTimer)
      this.autoTimer = null
    }
    if (!enabled || !(intervalHours > 0)) {
      logger.info('auto backup disabled')
      return
    }
    const ms = intervalHours * 3600_000
    // 启动时先评估一次（若上次定时快照距今已超过周期则立即补拍）
    this.tryScheduledBackup(ms)
    this.autoTimer = setInterval(() => this.tryScheduledBackup(ms), ms)
    logger.info('auto backup scheduled', { intervalHours })
  }

  /** 周期触发：距上次定时快照不足周期则跳过，避免重复 */
  private tryScheduledBackup(intervalMs: number): void {
    const last = this.list().find((b) => b.trigger === 'scheduled')
    if (last && Date.now() - last.createdAt < intervalMs) return
    void this.autoSnapshot('scheduled').then((info) => {
      if (info) logger.info('scheduled backup created', { id: info.id })
    })
  }

  getDshHome(): string {
    return dshManager.resolveDshHome()
  }

  /** 需要备份的 ~/.dsh 相对路径（存在才备份，排除大目录） */
  private backupSources(): string[] {
    const home = this.getDshHome()
    const candidates = [
      'settings.yaml',
      '.credentials.yaml',
      'profiles',
      'sessions',
      'plugins',
      'skills',
      'storages',
      '.agent-presets',
      'graph-memory'
    ]
    return candidates.filter((rel) => fs.existsSync(path.join(home, rel)))
  }

  private shouldExclude(rel: string): boolean {
    for (const seg of EXCLUDED_SEGMENTS) {
      if (rel.split(path.sep).includes(seg)) return true
    }
    for (const ext of EXCLUDED_EXTS) {
      if (rel.endsWith(ext)) return true
    }
    return false
  }

  private readMeta(dir: string): BackupMeta | null {
    try {
      const raw = fs.readFileSync(path.join(dir, '.backup-meta.json'), 'utf-8')
      return JSON.parse(raw) as BackupMeta
    } catch {
      return null
    }
  }

  /** 创建快照：source <= ~/.dsh 中存在的子路径 */
  async create(name: string, kind: 'manual' | 'auto' = 'manual', trigger = ''): Promise<BackupInfo | null> {
    this.init()
    const dshHome = this.getDshHome()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safeName = (name || (kind === 'auto' ? 'auto' : 'manual'))
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 40)
    const id = `${stamp}_${safeName}`
    const dest = path.join(this.backupDir, id)

    const meta: BackupMeta = { name: safeName, createdAt: Date.now(), kind, trigger }
    const sources = this.backupSources()
    if (sources.length === 0) {
      logger.warn('backup skipped: no dsh home sources', { dshHome })
      return null
    }

    let entryCount = 0
    let size = 0
    try {
      fs.mkdirSync(dest, { recursive: true })
      for (const rel of sources) {
        const src = path.join(dshHome, rel)
        const dst = path.join(dest, rel)
        if (fs.statSync(src).isFile()) {
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          fs.copyFileSync(src, dst)
          size += fs.statSync(dst).size
          entryCount++
        } else {
          fs.cpSync(src, dst, {
            recursive: true,
            filter: (s) => {
              const relPath = path.relative(src, s)
              if (!relPath) return true
              if (this.shouldExclude(relPath)) return false
              return true
            }
          })
          entryCount += this.countFiles(dst)
          size = this.sumSize(dest)
        }
      }
      fs.writeFileSync(path.join(dest, '.backup-meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
      logger.info(`backup created (${kind})`, { id, trigger, size })
      this.prune()
      return this.readMeta(dest) ? this.getInfo(id) : null
    } catch (err) {
      logger.error('backup create failed', err)
      try {
        fs.rmSync(dest, { recursive: true, force: true })
      } catch {
        /* noop */
      }
      return null
    }
  }

  private countFiles(dir: string): number {
    let n = 0
    try {
      const stack = [dir]
      while (stack.length) {
        const cur = stack.pop()
        if (!cur) continue
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const p = path.join(cur, e.name)
          if (e.isDirectory()) stack.push(p)
          else n++
        }
      }
    } catch {
      /* noop */
    }
    return n
  }

  private sumSize(dir: string): number {
    let s = 0
    try {
      const stack = [dir]
      while (stack.length) {
        const cur = stack.pop()
        if (!cur) continue
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const p = path.join(cur, e.name)
          if (e.isDirectory()) stack.push(p)
          else s += fs.statSync(p).size
        }
      }
    } catch {
      /* noop */
    }
    return s
  }

  list(): BackupInfo[] {
    this.init()
    const out: BackupInfo[] = []
    let dirs: string[] = []
    try {
      dirs = fs.readdirSync(this.backupDir)
    } catch {
      return []
    }
    for (const d of dirs) {
      const full = path.join(this.backupDir, d)
      if (!fs.statSync(full).isDirectory()) continue
      const info = this.getInfo(d)
      if (info) out.push(info)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  private getInfo(id: string): BackupInfo | null {
    const dir = path.join(this.backupDir, id)
    const meta = this.readMeta(dir)
    if (!meta) return null
    // 总大小 = 目录大小 - meta 文件
    const size = Math.max(0, this.sumSize(dir) - (this.readMetaFileSize(dir) ?? 0))
    const entryCount = Math.max(0, this.countFiles(dir) - 1)
    return {
      id,
      name: meta.name,
      createdAt: meta.createdAt,
      kind: meta.kind,
      trigger: meta.trigger,
      size,
      entryCount
    }
  }

  private readMetaFileSize(dir: string): number | null {
    try {
      return fs.statSync(path.join(dir, '.backup-meta.json')).size
    } catch {
      return null
    }
  }

  /** 恢复：先把当前状态拍一份保护快照，再把快照内容合并拷回 ~/.dsh */
  async restore(id: string): Promise<{ ok: boolean; error?: string }> {
    this.init()
    const src = path.join(this.backupDir, id)
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      return { ok: false, error: '快照不存在' }
    }
    const dshHome = this.getDshHome()
    try {
      // 恢复前保护快照
      await this.create('pre-restore', 'auto', `restore:${id}`)
      // 复制快照中的每个顶层条目（排除 meta 文件）
      for (const entry of fs.readdirSync(src)) {
        if (entry === '.backup-meta.json') continue
        const s = path.join(src, entry)
        const d = path.join(dshHome, entry)
        if (fs.statSync(s).isDirectory()) {
          fs.mkdirSync(d, { recursive: true })
          fs.cpSync(s, d, { recursive: true })
        } else {
          fs.mkdirSync(path.dirname(d), { recursive: true })
          fs.copyFileSync(s, d)
        }
      }
      logger.info('backup restored', { id, dshHome })
      return { ok: true }
    } catch (err) {
      logger.error('backup restore failed', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  delete(id: string): { ok: boolean; error?: string } {
    this.init()
    const target = path.join(this.backupDir, id)
    try {
      if (!target.startsWith(this.backupDir)) return { ok: false, error: '非法路径' }
      fs.rmSync(target, { recursive: true, force: true })
      logger.info('backup deleted', { id })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 保留策略：最多保留 MAX_BACKUPS 个；自动/定时快照优先清理，手动存档尽量保留 */
  private prune(): void {
    const all = this.list()
    if (all.length <= MAX_BACKUPS) return
    const excess = all.slice(MAX_BACKUPS)
    const autos = excess.filter((b) => b.kind === 'auto')
    if (autos.length > 0) {
      for (const b of autos) this.delete(b.id)
      return
    }
    for (const b of excess) this.delete(b.id)
    logger.info('pruned old backups', { removed: excess.length })
  }

  /** 供插件管理/自动更新调用的自动快照 */
  async autoSnapshot(trigger: string): Promise<BackupInfo | null> {
    return this.create('auto', 'auto', trigger)
  }
}

export const backupManager = new BackupManager()