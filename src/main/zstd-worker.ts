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
  cwd?: string
  title?: string
  firstUserText?: string
}

export class ZstdWorkerClient {
  private proc: ChildProcess | null = null
  private pending = new Map<number, (v: WorkerPayload) => void>()
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
            const resolve = this.pending.get(msg.id ?? -1)
            if (resolve) {
              this.pending.delete(msg.id ?? -1)
              resolve(msg)
            }
          } catch { /* noop */ }
        }
      })
      this.proc.on('exit', () => {
        this.proc = null
        for (const [, r] of this.pending) r({ ok: false, error: 'worker exited' })
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
      this.pending.set(id, resolvePromise as (v: WorkerPayload) => void)
      const stdin = proc.stdin
      if (!stdin) {
        this.pending.delete(id)
        resolvePromise({ ok: false, error: 'worker stdin closed' })
        return
      }
      stdin.write(JSON.stringify({ ...payload, cmd, id }) + '\n')
      // 超时兜底
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          resolvePromise({ ok: false, error: 'worker timeout' })
        }
      }, 15_000)
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