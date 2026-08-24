/**
 * 会话完成通知（文档 §4.2.3「任务完成」场景）
 * - 监听 ~/.dsh/sessions/<workspace>/session-<uuid>/session.jsonl.zstd 的文件活动
 * - 判定规则：文件在观察期发生过增长（会话活跃），随后持续无写入超过阈值 → 视为完成，发系统通知
 * - 只通知「本次观察到活跃后停止」的会话，避免旧会话误报；每个会话只通知一次
 * - 不解析 zstd 内容（无解压依赖），通知带工作区名与会话短标识
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import { notify } from './notify'
import { configStore } from './config'

/** 会话文件停止写入超过该时长（秒）视为完成；测试可用 DSH_SESSION_QUIET_MS 覆盖 */
const COMPLETE_QUIET_MS = Number(process.env.DSH_SESSION_QUIET_MS ?? 40_000)
/** 观察到的停滞时长超过该上限则不通知（中断残留，避免通知早已结束的会话） */
const MAX_STALE_MS = 6 * 3600_000
/** 轮询间隔；测试可用 DSH_SESSION_POLL_MS 覆盖 */
const POLL_MS = Number(process.env.DSH_SESSION_POLL_MS ?? 12_000)

interface Tracked {
  /** 最近一次 size 增长时间（会话最后活跃）；null = 尚未观察到增长（不可判完成） */
  lastGrewAt: number | null
  lastMtime: number
  lastSize: number
}

export interface SessionDoneEvent {
  sessionDir: string
  workspace: string
  uuid: string
}

export class SessionWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private tracked = new Map<string, Tracked>()
  /** 已判定完成的会话（防重通知；服务停止时清空） */
  private doneSessions = new Set<string>()

  /** 由 DSH 服务状态驱动：running → start，否则 stop */
  syncWithService(status: string): void {
    if (status === 'running') {
      this.start()
    } else {
      this.stop()
    }
  }

  start(): void {
    if (this.timer) return
    this.scan() // 立即扫一次建立基线
    this.timer = setInterval(() => this.scan(), POLL_MS)
    logger.info('session watcher started')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.tracked.clear()
    this.doneSessions.clear()
    logger.info('session watcher stopped')
  }

  private scan(): void {
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
        const jsonl = path.join(sessionDir, 'session.jsonl.zstd')
        const key = sessionDir
        // 已完成的不再观察（防重复通知）
        if (this.doneSessions.has(key)) continue
        try {
          const st = fs.statSync(jsonl)
          if (st.size === 0) continue
          const t = this.tracked.get(key)
          if (!t) {
            // 基线：unknown 活跃状态，等待观察到增长
            this.tracked.set(key, { lastGrewAt: null, lastMtime: st.mtimeMs, lastSize: st.size })
            continue
          }
          if (st.size > t.lastSize) {
            // 观察到增长 → 会话活跃
            t.lastSize = st.size
            t.lastMtime = st.mtimeMs
            t.lastGrewAt = now
            continue
          }
          // 未增长：仅对「观察期内活跃过」的会话判完成
          if (t.lastGrewAt === null) continue
          const quiet = now - t.lastGrewAt
          if (quiet > COMPLETE_QUIET_MS) {
            if (quiet < MAX_STALE_MS) {
              this.emitComplete({ sessionDir, workspace: ws, uuid: s.replace(/^session-/, '') })
              this.doneSessions.add(key)
            }
            // 丢弃该会话（无论是否通知）
            this.tracked.delete(key)
          }
        } catch {
          // 文件临时不可读（正在写入/删除）→ 忽略
          this.tracked.delete(key)
        }
      }
    }
  }

  private emitComplete(ev: SessionDoneEvent): void {
    this.emit('complete', ev)
    logger.info('session done detected', { workspace: ev.workspace, uuid: ev.uuid })
  }

  /** 供测试注入 */
  _debugState(): Map<string, Tracked> {
    return this.tracked
  }
}

/** 全局单例：由 index.ts 初始化并接线 */
export const sessionWatcher = new SessionWatcher()

/** 接线：DSH 状态变化 → watcher；会话完成 → 系统通知 */
export function wireSessionWatcher(): void {
  sessionWatcher.on('complete', (ev: SessionDoneEvent) => {
    if (!configStore.get().notifySessionDone) return
    const ws = ev.workspace.replace(/^--|--$/g, '').replace(/~(\d)/g, ' ') || '默认工作区'
    notify(
      'DSH 会话完成',
      `工作区「${ws}」的会话已完成（${ev.uuid.slice(0, 8)}）`,
      () => {
        const { shell } = require('electron') as typeof import('electron')
        void shell.openPath(path.dirname(ev.sessionDir))
      }
    )
  })
}