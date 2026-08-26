/**
 * zstd worker 客户端：主进程通过常驻系统 Node 子进程完成会话 zstd 解压
 * （Electron 内置 Node(20) 无 zstd，系统 Node ≥22.4 内置；无系统 Node 时优雅降级）
 */
import { app } from 'electron'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

interface WorkerPayload {
  ok: boolean
  error?: string
  zstd?: boolean
  events?: Array<{ type: string; seq: number }>
  turnEndMax?: number
  /** 新增帧中出现的 turn/end 事件（seq/time/reason.kind/turn 编号） */
  turnEnds?: Array<{ seq: number; time: number; kind?: string; turn?: number }>
  /** 新增帧中出现的 turn/start 事件数量 */
  turnStarts?: number
  /** 本批 seq 最大的 turn 事件类型：'start' 或 'end'；无 turn 事件时为 null */
  lastTurnType?: 'start' | 'end' | null
  /** 本批非 interrupted turn/end 的最大事件时间（ms） */
  lastEndTime?: number
  cwd?: string
  title?: string
  firstUserText?: string
}

export class ZstdWorkerClient {
  private proc: ChildProcess | null = null
  /** R-17: pending 附带超时定时器（响应到达/退出时清理，避免悬挂 15s） */
  private pending = new Map<number, { resolve: (v: WorkerPayload) => void; timer: NodeJS.Timeout }>()
  private seq = 0
  private buffer = ''

  private resolveNode(): string | null {
    if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) return process.env.DSH_NODE
    try {
      const out = execFileSync('where', ['node'], { windowsHide: true, timeout: 6_000, encoding: 'utf-8' })
      const p = out.trim().split(/\r?\n/)[0]
      if (p && fs.existsSync(p) && fs.statSync(p).size > 0) return p
    } catch {
      /* noop */
    }
    return null
  }

  private workerPath(): string {
    const candidates: string[] = []
    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, 'zstd-worker.cjs'))
    }
    candidates.push(path.join(app.getAppPath(), 'scripts', 'zstd-worker.cjs'))
    candidates.push(path.join(app.getAppPath(), 'zstd-worker.cjs'))
    candidates.push(path.join(process.cwd(), 'scripts', 'zstd-worker.cjs'))
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    return candidates[candidates.length - 1]
  }

  private ensure(): boolean {
    if (this.proc && !this.proc.killed) return true
    const node = this.resolveNode()
    if (!node) return false
    try {
      this.proc = spawn(node, [this.workerPath()], {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true
      })
      this.buffer = ''
      this.proc.stdout?.on('data', (c: Buffer) => {
        this.buffer += c.toString()
        let idx: number
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 1)
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line) as WorkerPayload & { id?: number }
            const entry = this.pending.get(msg.id ?? -1)
            if (entry) {
              this.pending.delete(msg.id ?? -1)
              clearTimeout(entry.timer)
              entry.resolve(msg)
            }
          } catch { /* noop */ }
        }
      })
      this.proc.on('exit', () => {
        this.proc = null
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer)
          entry.resolve({ ok: false, error: 'worker exited' })
        }
        this.pending.clear()
      })
      // R-17: stdin 写失败（worker 已退出/EPIPE）时拒绝所有 pending，避免未捕获异常
      this.proc.stdin?.on('error', () => {
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer)
          entry.resolve({ ok: false, error: 'worker stdin error' })
        }
        this.pending.clear()
      })
      return true
    } catch {
      return false
    }
  }

  request(cmd: string, payload: Record<string, unknown> = {}): Promise<WorkerPayload> {
    return new Promise((resolvePromise) => {
      if (!this.ensure()) {
        resolvePromise({ ok: false, error: '未找到支持 zstd 的系统 Node' })
        return
      }
      const proc = this.proc
      if (!proc) {
        resolvePromise({ ok: false, error: 'worker not ready' })
        return
      }
      const id = this.seq++
      // R-17: 超时定时器随请求入 pending，响应/退出时一并清理
      const timer = setTimeout(() => {
        const entry = this.pending.get(id)
        if (entry) {
          this.pending.delete(id)
          clearTimeout(entry.timer)
          entry.resolve({ ok: false, error: 'worker timeout' })
        }
      }, 15_000)
      this.pending.set(id, { resolve: resolvePromise as (v: WorkerPayload) => void, timer })
      const stdin = proc.stdin
      if (!stdin) {
        this.pending.delete(id)
        clearTimeout(timer)
        resolvePromise({ ok: false, error: 'worker stdin closed' })
        return
      }
      stdin.write(JSON.stringify({ ...payload, cmd, id }) + '\n')
    })
  }

  close(): void {
    try {
      this.proc?.stdin?.end()
      this.proc?.kill()
    } catch {
      /* noop */
    }
    this.proc = null
  }
}

export const zstdWorker = new ZstdWorkerClient()