/**
 * 对话完成通知（文档 §4.2.3「任务完成」）
 * - 语义：DSH 的 "turn/end" 表示「一轮对话结束」。每轮（turn）结束即立即通知，
 *   不做「会话级」判定——会话（session）可包含多轮，每一轮完成都是独立提醒。
 * - interrupted 是崩溃恢复时持久层合成的关闭标记（loop 从不主动发出），
 *   不代表一轮正常完成，不参与通知。
 * - 按轮（turn 编号）去重：同一轮只通知一次（DSH 崩溃修复可能产生重复 turn/end）。
 * - 无 turn/end 的会话（未完成任何一轮/中途异常退出）不通知——没有结束标记就
 *   静默，宁可漏报不可误报（不使用「停止写入」兜底）。
 * - 旧会话（观察期开始前已存在）不误报。
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import { notificationHub } from './notification-hub'
import { configStore } from './config'
import { windowManager } from './window-manager'
import { zstdWorker } from './zstd-worker'
import { decodeWorkspaceName, projectNameFromPath } from '../shared/session-jsonl'

/** 轮询间隔（只影响发现新帧的时延；非法值回落默认，限制在 [500ms, 60s]） */
const POLL_RAW = Number(process.env.DSH_SESSION_POLL_MS ?? 2_000)
const POLL_MS = Number.isFinite(POLL_RAW) ? Math.min(60_000, Math.max(500, POLL_RAW)) : 2_000
/** 单会话去重记录上限（防止超长会话的 notifiedTurns 无限增长） */
const MAX_NOTIFIED_TURNS = 200

interface Tracked {
  readOffset: number
  /** 已通知过的轮次编号（Set<turn 编号>；防止同一轮重复通知） */
  notifiedTurns: Set<number>
}

export interface SessionDoneEvent {
  sessionDir: string
  workspace: string
  uuid: string
  file: string
  /** 本轮轮次编号（turn/end 的 data.turn；缺失时为 undefined） */
  turn?: number
}

export class SessionWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private tracked = new Map<string, Tracked>()
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
    zstdWorker.close()
    logger.info('session watcher stopped')
  }

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const sessionsRoot = path.join(dshManager.resolveDshHome(), 'sessions')
      // off 时跳过目录扫描（性能）；粒度终判仍以 notification-hub 为准（hub 会再 gate）
      if (configStore.get().notifySessionDone === 'off') {
        this.tracked.clear()
        return
      }
      let workspaceDirs: string[] = []
      try {
        // H3: 异步目录遍历，避免阻塞主进程事件循环
        workspaceDirs = await fs.promises.readdir(sessionsRoot)
      } catch {
        return
      }

      // H3: 本轮扫描到的会话键集合，用于清理已删除会话的 tracked 条目
      const seen = new Set<string>()

      for (const ws of workspaceDirs) {
        const wsDir = path.join(sessionsRoot, ws)
        let sessionDirs: string[] = []
        try {
          if (!(await fs.promises.stat(wsDir)).isDirectory()) continue
          sessionDirs = await fs.promises.readdir(wsDir)
        } catch {
          continue
        }
        for (const s of sessionDirs) {
          if (!s.startsWith('session-')) continue
          const sessionDir = path.join(wsDir, s)
          const file = path.join(sessionDir, 'session.jsonl.zstd')
          const key = sessionDir
          seen.add(key)

          let size = 0
          try {
            size = (await fs.promises.stat(file)).size
          } catch {
            continue
          }
          if (size === 0) continue

          let t = this.tracked.get(key)
          if (!t) {
            // 基线：仅记录偏移，不处理旧内容（避免启动时对历史会话批量通知）
            this.tracked.set(key, { readOffset: size, notifiedTurns: new Set<number>() })
            continue
          }

          // H3: 文件被截断/重写（repair re-encode）后 size 变小：重置基线，避免永久漏报
          if (size < t.readOffset) {
            t.readOffset = size
            continue
          }

          if (size > t.readOffset) {
            const oldOffset = t.readOffset
            // 解析新增帧中的轮次结束事件：每轮（非 interrupted）结束立即通知
            const r = await zstdWorker.request('frameEvents', { file, offset: oldOffset })
            if (r.ok) {
              // H3: 成功后才推进偏移——失败不推进，下一轮重试（避免该批新帧被永久跳过）
              t.readOffset = size
              for (const te of r.turnEnds ?? []) {
                // interrupted = 崩溃恢复时持久层合成的关闭标记，不代表一轮完成
                if (te.kind === 'interrupted') continue
                // 按轮去重：同一轮只通知一次（DSH 崩溃修复可能重写重复 turn/end）
                const turnKey = te.turn ?? te.seq
                if (t.notifiedTurns.has(turnKey)) continue
                t.notifiedTurns.add(turnKey)
                // H3: 去重记录设上限，防止超长会话内存增长
                if (t.notifiedTurns.size > MAX_NOTIFIED_TURNS) {
                  t.notifiedTurns = new Set([...t.notifiedTurns].slice(-MAX_NOTIFIED_TURNS))
                }
                this.emitComplete({
                  sessionDir,
                  workspace: ws,
                  uuid: s.replace(/^session-/, ''),
                  file,
                  turn: te.turn
                })
              }
            }
          }
        }
      }
      // H3: 清理已删除会话的 tracked 条目（防内存增长）
      for (const k of this.tracked.keys()) {
        if (!seen.has(k)) this.tracked.delete(k)
      }
    } finally {
      this.scanning = false
    }
  }

  private emitComplete(ev: SessionDoneEvent): void {
    this.emit('complete', ev)
    logger.info('turn done detected', { workspace: ev.workspace, uuid: ev.uuid, turn: ev.turn })
  }

  _debugState(): Map<string, Tracked> {
    return this.tracked
  }
}

export const sessionWatcher = new SessionWatcher()

/** 接线：DSH 状态变化 → watcher；每轮对话完成 → 通知事件中枢（显示层可插拔，点击唤起窗口+定位会话） */
export function wireSessionWatcher(): void {
  sessionWatcher.on('complete', async (ev: SessionDoneEvent) => {
    // off 时跳过 headInfo 取数（避免无谓 zstd IO）；粒度终判仍以 notification-hub 为准
    if (configStore.get().notifySessionDone === 'off') return

    let title = `会话 ${ev.uuid.slice(0, 8)}`
    let project = ''
    let firstUserText = ''
    const head = await zstdWorker.request('headInfo', { file: ev.file })
    if (head.ok) {
      const cwd = head.cwd ?? ''
      title = head.title || title
      firstUserText = head.firstUserText ?? ''
      project = cwd ? projectNameFromPath(cwd) : ''
    } else {
      logger.warn('session head info unavailable (zstd), fallback ids', ev.uuid)
    }
    if (!project) project = projectNameFromPath(decodeWorkspaceName(ev.workspace))

    // 正文带轮次：项目「X」· 标题（第 N 轮）
    const turnSuffix = ev.turn ? `（第 ${ev.turn} 轮）` : ''
    const body = project ? `项目「${project}」· ${title}${turnSuffix}` : `${title}${turnSuffix}`
    notificationHub.dispatch({
      id: randomUUID(),
      kind: 'session-done',
      title: 'DSH 对话完成',
      body,
      ts: Date.now(),
      session: {
        sessionDir: ev.sessionDir,
        workspace: ev.workspace,
        uuid: ev.uuid,
        file: ev.file,
        turn: ev.turn,
        project,
        sessionTitle: title,
        firstUserText
      },
      // 原生通道点击：唤起窗口 + 定位会话（DOM hack 兜底；webview 通道由插件 ctx.sessions.open 激活）
      actions: {
        onClick: () => {
          windowManager.show()
          windowManager.activateSessionInWebUi(title, firstUserText, ev.uuid)
        }
      }
    })
  })
}
