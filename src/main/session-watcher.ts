/**
 * 会话完成通知（文档 §4.2.3「任务完成」）
 * - 事件驱动：增量读取会话 jsonl.zstd 新增帧，检测 DSH 原生事件 `turn/end` →
 *   立即判定完成并通知（不依赖"停止写入"猜测）
 * - 解压：经系统 Node 常驻 worker（zstd-worker.cjs）；无系统 Node 时降级为
 *   「停止写入超阈值」兜底判定，标题回退会话短号
 * - 每个会话只通知一次；旧会话（观察期无新事件）不误报
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import { notify } from './notify'
import { configStore } from './config'
import { windowManager } from './window-manager'
import { zstdWorker } from './zstd-worker'
import { decodeWorkspaceName, projectNameFromPath } from '../shared/session-jsonl'

/** 轮询间隔（事件驱动下只影响发现新帧的时延） */
const POLL_MS = Number(process.env.DSH_SESSION_POLL_MS ?? 2_000)
/** 兜底（无 turn/end 或无线程 Node）：停止写入超阈值判定完成 */
const FALLBACK_QUIET_MS = Number(process.env.DSH_SESSION_QUIET_MS ?? 60_000)

interface Tracked {
  readOffset: number
  lastTurnEndSeq: number
  lastGrewAt: number
  seen: boolean
}

export interface SessionDoneEvent {
  sessionDir: string
  workspace: string
  uuid: string
  file: string
}

export class SessionWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private tracked = new Map<string, Tracked>()
  private doneSessions = new Set<string>()
  private scanning = false

  syncWithService(status: string): void {
    if (status === 'running') this.start()
    else this.stop()
  }

  start(): void {
    if (this.timer) return
    void this.scan()
    this.timer = setInterval(() => void this.scan(), POLL_MS)
    logger.info('session watcher started (event-driven)')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.tracked.clear()
    this.doneSessions.clear()
    zstdWorker.close()
    logger.info('session watcher stopped')
  }

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const sessionsRoot = path.join(dshManager.resolveDshHome(), 'sessions')
      if (!configStore.get().notifySessionDone) {
        this.tracked.clear()
        return
      }
      let workspaceDirs: string[] = []
      try {
        workspaceDirs = fs.readdirSync(sessionsRoot)
      } catch {
        return
      }
      const now = Date.now()

      for (const ws of workspaceDirs) {
        const wsDir = path.join(sessionsRoot, ws)
        let sessionDirs: string[] = []
        try {
          if (!fs.statSync(wsDir).isDirectory()) continue
          sessionDirs = fs.readdirSync(wsDir)
        } catch {
          continue
        }
        for (const s of sessionDirs) {
          if (!s.startsWith('session-')) continue
          const sessionDir = path.join(wsDir, s)
          const file = path.join(sessionDir, 'session.jsonl.zstd')
          const key = sessionDir
          if (this.doneSessions.has(key)) continue

          let size = 0
          try {
            size = fs.statSync(file).size
          } catch {
            continue
          }
          if (size === 0) continue

          let t = this.tracked.get(key)
          if (!t) {
            this.tracked.set(key, { readOffset: size, lastTurnEndSeq: 0, lastGrewAt: now, seen: false })
            continue
          }

          if (size > t.readOffset) {
            const oldOffset = t.readOffset
            t.lastGrewAt = now
            t.readOffset = size
            t.seen = true
            // 事件驱动主路径：worker 解新增帧，检测 turn/end
            const r = await zstdWorker.request('frameEvents', { file, offset: oldOffset })
            if (r.ok && (r.turnEndMax ?? 0) > t.lastTurnEndSeq) {
              t.lastTurnEndSeq = r.turnEndMax ?? 0
              this.emitComplete({ sessionDir, workspace: ws, uuid: s.replace(/^session-/, ''), file })
            }
            continue
          }

          // 兜底：观察中但未出现 turn/end，停止写入超阈值
          if (t.seen && now - t.lastGrewAt > FALLBACK_QUIET_MS) {
            this.emitComplete({ sessionDir, workspace: ws, uuid: s.replace(/^session-/, ''), file })
          }
        }
      }
    } finally {
      this.scanning = false
    }
  }

  private emitComplete(ev: SessionDoneEvent): void {
    if (this.doneSessions.has(ev.sessionDir)) return
    this.doneSessions.add(ev.sessionDir)
    this.emit('complete', ev)
    logger.info('session done detected', { workspace: ev.workspace, uuid: ev.uuid })
  }

  _debugState(): Map<string, Tracked> {
    return this.tracked
  }
}

export const sessionWatcher = new SessionWatcher()

/** 接线：DSH 状态变化 → watcher；会话完成 → 系统通知（标题/项目，点击唤起主窗口并尝试定位会话） */
export function wireSessionWatcher(): void {
  sessionWatcher.on('complete', async (ev: SessionDoneEvent) => {
    if (!configStore.get().notifySessionDone) return

    let title = `会话 ${ev.uuid.slice(0, 8)}`
    let project = ''
    const head = await zstdWorker.request('headInfo', { file: ev.file })
    if (head.ok) {
      const cwd = head.cwd ?? ''
      title = head.title || title
      project = cwd ? projectNameFromPath(cwd) : ''
    } else {
      logger.warn('session head info unavailable (zstd), fallback ids', ev.uuid)
    }
    if (!project) project = projectNameFromPath(decodeWorkspaceName(ev.workspace))

    const body = project ? `项目「${project}」· ${title}` : title
    notify('DSH 会话完成', body, () => {
      windowManager.show()
      windowManager.activateSessionInWebUi(title)
    })
  })
}