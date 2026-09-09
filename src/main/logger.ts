/**
 * 主进程日志模块
 * 日志位置：%APPDATA%\DSH-Exoskeleton\dsh-desktop.log（文档 §8.2）
 * 同时维护内存环形缓冲，供渲染进程仪表盘实时查看
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { LogEntry } from '../shared/types'

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB 轮转
const MAX_MEMORY_ENTRIES = 500

class Logger {
  private filePath = ''
  private memory: LogEntry[] = []
  private stream: fs.WriteStream | null = null
  /** R-14: 已写入文件字节数（运行期轮转判定） */
  private bytesWritten = 0
  /** R-14: 轮转期间暂存的新日志行 */
  private pendingLines: string[] = []
  /** R-14: 轮转进行中标志（防止并发触发） */
  private rotating = false
  /** 清空操作代号：clear() 自增后，进行中的轮转回调据此放弃（否则会把已删除的旧文件又改名回来） */
  private generation = 0

  init(): void {
    try {
      const dir = app.getPath('userData')
      fs.mkdirSync(dir, { recursive: true })
      this.filePath = path.join(dir, 'dsh-desktop.log')
      // 轮转：文件超过上限时改名 .1；记录当前大小供运行期轮转判定
      try {
        const stat = fs.statSync(this.filePath)
        if (stat.size > MAX_FILE_SIZE) {
          fs.renameSync(this.filePath, this.filePath + '.1')
          this.bytesWritten = 0
        } else {
          this.bytesWritten = stat.size
        }
      } catch {
        /* 首次启动无文件 */
      }
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' })
      this.info('logger initialized', { file: this.filePath })
    } catch (err) {
      // 日志初始化失败不影响应用运行
      console.error('[logger] init failed:', err)
    }
  }

  private write(level: LogEntry['level'], message: string, extra?: unknown): void {
    const entry: LogEntry = {
      time: Date.now(),
      level,
      message: extra === undefined ? message : `${message} ${this.serialize(extra)}`
    }
    this.memory.push(entry)
    if (this.memory.length > MAX_MEMORY_ENTRIES) this.memory.shift()

    const line = '[' + new Date(entry.time).toISOString() + '] [' + level.toUpperCase() + '] ' + entry.message + '\n'
    const bytes = Buffer.byteLength(line)
    this.bytesWritten += bytes
    try {
      if (this.stream) {
        this.stream.write(line)
      } else {
        // R-14: 轮转进行中暂存，轮转完成后补写
        this.pendingLines.push(line)
      }
    } catch {
      /* noop */
    }
    // R-14: 运行期轮转——超过上限时滚动文件（不再依赖仅启动时检查）
    if (this.bytesWritten > MAX_FILE_SIZE && !this.rotating) {
      this.rotate()
    }
    if (level === 'error' || level === 'warn') {
      // 同时输出到控制台便于开发调试
      console[level === 'error' ? 'error' : 'warn'](entry.message)
    }
  }

  /** R-14: 运行期轮转：关闭旧流 → 改名 .1 → 重建流 → 补写暂存行 */
  private rotate(): void {
    this.rotating = true
    const gen = this.generation
    const old = this.stream
    this.stream = null
    if (old) {
      old.end(() => {
        // clear() 已介入：旧文件已被删除，本次轮转作废（pendingLines 交给 clear 补写）
        if (gen !== this.generation) {
          this.rotating = false
          return
        }
        try {
          if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, this.filePath + '.1')
          this.stream = fs.createWriteStream(this.filePath, { flags: 'a' })
          this.bytesWritten = 0
          const pending = this.pendingLines
          this.pendingLines = []
          for (const l of pending) this.stream?.write(l)
          this.bytesWritten += pending.reduce((n, l) => n + Buffer.byteLength(l), 0)
        } catch (err) {
          console.error('[logger] rotate failed:', err)
        } finally {
          this.rotating = false
        }
      })
    } else {
      this.rotating = false
    }
  }

  private serialize(extra: unknown): string {
    try {
      return JSON.stringify(extra)
    } catch {
      return String(extra)
    }
  }

  debug(message: string, extra?: unknown): void {
    this.write('debug', message, extra)
  }
  info(message: string, extra?: unknown): void {
    this.write('info', message, extra)
  }
  warn(message: string, extra?: unknown): void {
    this.write('warn', message, extra)
  }
  error(message: string, extra?: unknown): void {
    this.write('error', message, extra)
  }

  list(limit = 200): LogEntry[] {
    return this.memory.slice(-limit)
  }

  /**
   * 清空日志：内存缓冲 + 日志文件（含 .1 轮转备份）。
   * 顺序讲究：先清内存（面板立即空白）→ 关流 → 删文件 → 重建流并补写期间产生的日志，
   * 这样清空过程中新产生的日志既不丢文件也不丢视图；Windows 下先关流再删更稳。
   */
  async clear(): Promise<{ ok: boolean; error?: string }> {
    if (!this.filePath) return { ok: false, error: '日志尚未初始化' }
    this.generation++
    this.memory = []
    const old = this.stream
    this.stream = null
    await new Promise<void>((resolve) => {
      if (!old) return resolve()
      old.end(() => resolve())
    })
    try {
      for (const p of [this.filePath, this.filePath + '.1']) {
        try {
          fs.rmSync(p, { force: true })
        } catch {
          /* 单文件删除失败（如被外部编辑器占用）不阻断整体清空 */
        }
      }
      this.bytesWritten = 0
      const pending = this.pendingLines
      this.pendingLines = []
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' })
      for (const l of pending) this.stream.write(l)
      this.bytesWritten += pending.reduce((n, l) => n + Buffer.byteLength(l), 0)
      this.rotating = false
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  getFile(): string {
    return this.filePath
  }
}

export const logger = new Logger()