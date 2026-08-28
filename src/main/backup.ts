/**
 * 备份与回滚（文档 §4.3.4）
 * - 手动存档 + 自动快照（插件安装/卸载、自动更新前）
 * - 一键回退到指定快照（恢复前自动再拍快照保护）
 * - 快照存储于 userData/backups/
 * R-9: 复制/统计全部异步化并增量累加（避免同步阻塞主进程与重复全量扫描）
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

  init(): void {
    this.backupDir = path.join(app.getPath('userData'), 'backups')
    fs.mkdirSync(this.backupDir, { recursive: true })
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

  /** 异步遍历目录统计（size/count 一次完成，避免多次全量扫描） */
  private async scanDirAsync(dir: string): Promise<{ size: number; count: number }> {
    let size = 0
    let count = 0
    const stack: string[] = [dir]
    while (stack.length) {
      const cur = stack.pop()
      if (!cur) continue
      let entries: fs.Dirent[] = []
      try {
        entries = await fs.promises.readdir(cur, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const p = path.join(cur, e.name)
        if (e.isDirectory()) {
          stack.push(p)
        } else {
          count++
          try {
            size += (await fs.promises.stat(p)).size
          } catch {
            /* noop */
          }
        }
      }
    }
    return { size, count }
  }

  /** 创建快照：source <= ~/.dsh 中存在的子路径 */
  async create(name: string, kind: 'manual' | 'auto' = 'manual', trigger = ''): Promise<BackupInfo | null> {
    this.init()
    const dshHome = this.getDshHome()
    // R-20: 保留毫秒精度，避免同秒同名（如连续 auto 快照）撞目录互相覆盖
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeName = (name || (kind === 'auto' ? 'auto' : 'manual'))
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 40)
    const id = stamp + '_' + safeName
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
          await fs.promises.copyFile(src, dst)
          size += (await fs.promises.stat(dst)).size
          entryCount++
        } else {
          await fs.promises.cp(src, dst, {
            recursive: true,
            filter: (s) => {
              const relPath = path.relative(src, s)
              if (!relPath) return true
              if (this.shouldExclude(relPath)) return false
              return true
            }
          })
          // R-9: 只统计刚复制的子目录，避免每次对整个 dest 全量重扫
          const st = await this.scanDirAsync(dst)
          entryCount += st.count
          size += st.size
        }
      }
      fs.writeFileSync(path.join(dest, '.backup-meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
      logger.info('backup created (' + kind + ')', { id, trigger, size })
      await this.prune()
      return this.readMeta(dest) ? await this.getInfo(id) : null
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

  async list(): Promise<BackupInfo[]> {
    this.init()
    const out: BackupInfo[] = []
    let dirs: string[] = []
    try {
      dirs = await fs.promises.readdir(this.backupDir)
    } catch {
      return []
    }
    for (const d of dirs) {
      const full = path.join(this.backupDir, d)
      try {
        if (!(await fs.promises.stat(full)).isDirectory()) continue
      } catch {
        continue
      }
      const info = await this.getInfo(d)
      if (info) out.push(info)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  private async getInfo(id: string): Promise<BackupInfo | null> {
    const dir = path.join(this.backupDir, id)
    const meta = this.readMeta(dir)
    if (!meta) return null
    // 顶层条目（排除 meta 文件）= 可任选恢复的项目
    let entries: string[] = []
    try {
      entries = (await fs.promises.readdir(dir)).filter((e) => e !== '.backup-meta.json').sort()
    } catch {
      /* noop */
    }
    // 总大小 = 目录大小 - meta 文件（单次遍历同时取得 size/count）
    const scan = await this.scanDirAsync(dir)
    const metaSize = this.readMetaFileSize(dir) ?? 0
    return {
      id,
      name: meta.name,
      createdAt: meta.createdAt,
      kind: meta.kind,
      trigger: meta.trigger,
      size: Math.max(0, scan.size - metaSize),
      entryCount: Math.max(0, scan.count - 1),
      entries
    }
  }

  private readMetaFileSize(dir: string): number | null {
    try {
      return fs.statSync(path.join(dir, '.backup-meta.json')).size
    } catch {
      return null
    }
  }

  /**
   * 恢复：先把当前状态拍一份保护快照，再把快照内容合并拷回 ~/.dsh。
   * entries 为空/缺省 = 恢复全部顶层条目；指定则只恢复所选条目（如只恢复 plugins）。
   */
  async restore(id: string, entries?: string[]): Promise<{ ok: boolean; error?: string }> {
    this.init()
    const src = path.join(this.backupDir, id)
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      return { ok: false, error: '快照不存在' }
    }
    const dshHome = this.getDshHome()
    // 快照顶层条目（排除 meta）作为可恢复集合的唯一权威来源
    let top: string[] = []
    try {
      top = (await fs.promises.readdir(src)).filter((e) => e !== '.backup-meta.json')
    } catch {
      return { ok: false, error: '读取快照内容失败' }
    }
    // 任选恢复：条目必须真实属于该快照顶层（天然排除路径穿越/越界）
    let targets: string[] = top
    if (entries && entries.length > 0) {
      const bad = entries.filter((e) => typeof e !== 'string' || !top.includes(e) || e === '.backup-meta.json')
      if (bad.length > 0) {
        return { ok: false, error: '包含无法识别的恢复项：' + bad.join('、') }
      }
      targets = entries
    }
    try {
      // 恢复前保护快照（R-25: 失败则中止恢复，避免无保护直接覆盖）
      const guard = await this.create('pre-restore', 'auto', 'restore:' + id)
      if (!guard) return { ok: false, error: '恢复前保护快照创建失败，已中止恢复' }
      // 复制所选顶层条目（排除 meta 文件）
      for (const entry of targets) {
        const s = path.join(src, entry)
        const d = path.join(dshHome, entry)
        if ((await fs.promises.stat(s)).isDirectory()) {
          fs.mkdirSync(d, { recursive: true })
          await fs.promises.cp(s, d, { recursive: true })
        } else {
          fs.mkdirSync(path.dirname(d), { recursive: true })
          await fs.promises.copyFile(s, d)
        }
      }
      logger.info('backup restored', { id, dshHome, entries: targets })
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
  private async prune(): Promise<void> {
    let removed = 0
    let all = await this.list()
    while (all.length > MAX_BACKUPS) {
      const excess = all.slice(MAX_BACKUPS)
      // 自动快照优先清理；无自动快照时才清手动存档（循环直到不超过上限）
      const victims = excess.filter((b) => b.kind === 'auto')
      const toRemove = victims.length > 0 ? victims : excess
      for (const b of toRemove) {
        this.delete(b.id)
        removed++
      }
      all = await this.list()
    }
    if (removed > 0) logger.info('pruned old backups', { removed })
  }

  /** 供插件管理/自动更新调用的自动快照 */
  async autoSnapshot(trigger: string): Promise<BackupInfo | null> {
    return this.create('auto', 'auto', trigger)
  }
}

export const backupManager = new BackupManager()
