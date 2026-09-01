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
import { closeNotification } from './notify'
import { decodeWorkspaceName, projectNameFromPath } from '../shared/session-jsonl'

/** 兜底轮询间隔（主触发是 fs.watch，这是 fs.watch 失效时的保底；非法值回落默认，限制在 [500ms, 60s]） */
const POLL_RAW = Number(process.env.DSH_SESSION_POLL_MS ?? 500)
const POLL_MS = Number.isFinite(POLL_RAW) ? Math.min(60_000, Math.max(500, POLL_RAW)) : 500
/** fs.watch 触发后的扫描防抖（一次写入可能触发多次 change 事件，合并为一次扫描） */
const WATCH_DEBOUNCE_MS = 120
/** 单会话去重记录上限（防止超长会话的 notifiedTurns 无限增长） */
const MAX_NOTIFIED_TURNS = 200

interface Tracked {
  readOffset: number
  /** 已通知过的轮次编号（Set<turn 编号>；防止同一轮重复通知） */
  notifiedTurns: Set<number>
  /** session-ask：等待回答的询问卡集合（callId → 卡片信息）。
   *  判定：tool/call（白名单工具）已记录而同 callId 的 tool/result 未出现 ⇒ 卡片等待中。
   *  callId 在 pending 集合内即天然去重（重扫同批帧不会重复通知）。 */
  pendingAsks: Map<string, { turn: number; openedAt: number; questions?: string[] }>
}

export interface SessionDoneEvent {
  sessionDir: string
  workspace: string
  uuid: string
  file: string
  /** 本轮轮次编号（turn/end 的 data.turn；缺失时为 undefined） */
  turn?: number
}

/** session-ask：询问卡打开事件（tool/call 已入日志且等待 tool/result 配对） */
export interface SessionAskEvent extends SessionDoneEvent {
  /** tool/call 的 callId（与 pendingAsks 键一致） */
  callId: string
  /** 卡片问题文本（worker 内已解析截断；解析失败时为 undefined，壳侧回退通用文案） */
  questions?: string[]
}

export class SessionWatcher extends EventEmitter {
  /** 兜底轮询定时器 */
  private timer: NodeJS.Timeout | null = null
  /** fs.watch 递归监听 sessions 根目录（主触发，近零延迟）；不可用时回退纯轮询 */
  private watcher: fs.FSWatcher | null = null
  /** fs.watch 事件防抖定时器 */
  private debounceTimer: NodeJS.Timeout | null = null
  private tracked = new Map<string, Tracked>()
  private scanning = false

  syncWithService(status: string): void {
    if (status === 'running') this.start()
    else this.stop()
  }

  start(): void {
    if (this.timer) return
    void this.scan()
    // 主触发：fs.watch 递归监听 sessions 目录，文件一变化即扫描（近零延迟，方案 B）
    this.setupWatcher()
    // 兜底轮询：fs.watch 漏事件 / 新建目录未纳入监听时，保证最差一个轮询间隔内发现（方案 A，500ms）
    this.timer = setInterval(() => void this.scan(), POLL_MS)
    logger.info(`session watcher started (fs.watch + fallback poll ${POLL_MS}ms)`)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.closeWatcher()
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.tracked.clear()
    zstdWorker.close()
    logger.info('session watcher stopped')
  }

  /** fs.watch 递归监听 sessions 根；目录不存在时静默等待（scan 里目录就绪后补挂），挂不上则纯轮询 */
  private setupWatcher(): void {
    const root = path.join(dshManager.resolveDshHome(), 'sessions')
    try {
      if (!fs.existsSync(root)) {
        this.watcher = null
        return
      }
      this.watcher = fs.watch(root, { recursive: true }, () => this.scheduleScan())
      this.watcher.on('error', (err) => {
        logger.warn('session fs.watch error, fallback to poll', err)
        this.closeWatcher()
      })
      logger.debug('session fs.watch armed', { root })
    } catch (err) {
      logger.warn('session fs.watch unavailable, fallback to poll', err)
      this.watcher = null
    }
  }

  private closeWatcher(): void {
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        /* 忽略 */
      }
      this.watcher = null
    }
  }

  /** fs.watch 事件防抖：一次写入可能触发多次 change，合并为一次扫描 */
  private scheduleScan(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.scan()
    }, WATCH_DEBOUNCE_MS)
  }

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const sessionsRoot = path.join(dshManager.resolveDshHome(), 'sessions')
      // off 时跳过目录扫描（性能）；粒度终判仍以 notification-hub 为准（hub 会再 gate）。
      // session-ask：任一开关开启都需要扫描（扫描是两个检测的共用通道，短路条件取与）
      const cfgGate = configStore.get()
      if (cfgGate.notifySessionDone === 'off' && cfgGate.notifyAskCard === false) {
        this.tracked.clear()
        return
      }
      // fs.watch 若未挂上（启动时 sessions 目录尚未创建），目录就绪后补挂一次
      if (!this.watcher && fs.existsSync(sessionsRoot)) this.setupWatcher()
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
          const uuid = s.replace(/^session-/, '')
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
            // 基线：仅记录偏移，不处理旧内容（避免启动时对历史会话批量通知）。
            // 已挂着的询问卡同样不回填（与 turn/end 基线语义一致）
            this.tracked.set(key, { readOffset: size, notifiedTurns: new Set<number>(), pendingAsks: new Map() })
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
              // session-ask 结果优先：同批帧内 result 先于 call 处理（call+result 同批到达 = 秒答，不通知）
              const batchResults = new Set(r.toolResultCallIds ?? [])
              for (const cid of batchResults) {
                if (t.pendingAsks.delete(cid)) {
                  dismissAskNotify(uuid, cid)
                }
              }
              for (const op of r.askOpens ?? []) {
                if (!op.callId || batchResults.has(op.callId) || t.pendingAsks.has(op.callId)) continue
                t.pendingAsks.set(op.callId, { turn: op.turn ?? 0, openedAt: op.time ?? Date.now(), questions: op.questions })
                this.emitAskOpen({
                  sessionDir,
                  workspace: ws,
                  uuid: s.replace(/^session-/, ''),
                  file,
                  turn: op.turn,
                  callId: op.callId,
                  questions: op.questions
                })
              }
              // 崩溃/中止清理：turn 已结束则该轮的卡片不可能还在等待（正常流程卡片回答后才可能继续/结束轮）
              for (const te of r.turnEnds ?? []) {
                if (te.turn === undefined) continue
                for (const [cid, info] of t.pendingAsks) {
                  if (info.turn === te.turn) {
                    t.pendingAsks.delete(cid)
                    dismissAskNotify(uuid, cid)
                  }
                }
              }
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

  private emitAskOpen(ev: SessionAskEvent): void {
    // 通知开关终判在 wire 层（与 session-done 的 off 跳过 headInfo 一致）
    this.emit('askOpen', ev)
    logger.info('ask card opened detected', { workspace: ev.workspace, uuid: ev.uuid, turn: ev.turn, callId: ev.callId })
  }

  _debugState(): Map<string, Tracked> {
    return this.tracked
  }
}

export const sessionWatcher = new SessionWatcher()

/** session-ask：callId → 已发通知事件 id（用户回答后撤销操作中心残留 toast；P2 撤销）。
 *  键 `${uuid}|${callId}`：同 callId 在不同会话理论上可复现，加 uuid 隔离 */
const askNotifyIds = new Map<string, string>()

/** 卡片已回答/已清理：撤销对应原生通知（无记录时静默——如 webview 通道 toast 自然超时） */
function dismissAskNotify(uuid: string, callId: string): void {
  const k = uuid + '|' + callId
  const evId = askNotifyIds.get(k)
  if (!evId) return
  askNotifyIds.delete(k)
  if (!closeNotification(evId)) {
    logger.debug('ask notification dismiss skipped (not found)', { uuid, callId })
  }
}

/** 接线：DSH 状态变化 → watcher；每轮对话完成 → 通知事件中枢（显示层可插拔，点击唤起窗口+定位会话） */
export function wireSessionWatcher(): void {
  sessionWatcher.on('complete', async (ev: SessionDoneEvent) => {
    // off 时跳过 headInfo 取数（避免无谓 zstd IO）；粒度终判仍以 notification-hub 为准
    if (configStore.get().notifySessionDone === 'off') return

    // 会话感知抑制（壳侧实现，不依赖插件）：窗口聚焦（用户在看着 DSH）且完成会话 ==
    // UI 当前选中会话 → 不弹（正在看的会话无需打扰）；后台会话完成才弹。
    // 读不到当前会话（SPA 结构变化）时回退为不抑制——宁可多弹不漏报。
    if (windowManager.isWindowActive()) {
      const current = await windowManager.getActiveSessionId()
      if (current && current === ev.uuid) {
        logger.debug('notification suppressed (active session in view)', { uuid: ev.uuid })
        return
      }
    }

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
      // 通知点击（原生通道 actions）：唤起窗口 + 定位会话。
      // 修复「点击通知偶尔不跳转」：优先转发 webview 插件用 sessions.open 程序化激活
      // （可靠、会话 ID 精确）；webview 离线才回退 executeJavaScript DOM hack。
      actions: {
        onClick: () => {
          // 诊断日志：确认原生通知点击链路触发（置顶问题排查用）
          logger.debug('native notification clicked (session-done)', { uuid: ev.uuid })
          windowManager.show()
          if (!notificationHub.requestActivate(ev.uuid)) {
            windowManager.activateSessionInWebUi(title, firstUserText, ev.uuid)
          }
        }
      }
    })
  })

  // session-ask：询问卡等待回答通知。检测：tool/call（白名单工具）无配对 result（session-watcher 维护
  // pending 集合）；回答后 result 配对到达 → dismissAskNotify 撤销原生 toast（扫描层调用）。
  sessionWatcher.on('askOpen', async (ev: SessionAskEvent) => {
    if (configStore.get().notifyAskCard === false) return

    // 与 session-done 相同的会话感知抑制：用户正看着该会话时页面内卡片本身可见，无需打扰；
    // 读不到当前会话时回退为不抑制（宁可多弹不漏报）
    if (windowManager.isWindowActive()) {
      const current = await windowManager.getActiveSessionId()
      if (current && current === ev.uuid) {
        logger.debug('ask notification suppressed (active session in view)', { uuid: ev.uuid })
        return
      }
    }

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

    const turnSuffix = ev.turn ? `（第 ${ev.turn} 轮）` : ''
    const askText = ev.questions && ev.questions.length > 0 ? ev.questions.join(' / ') : 'Agent 等待你的回答'
    const body = project ? `项目「${project}」· ${title}${turnSuffix} · ${askText}` : `${title}${turnSuffix} · ${askText}`
    const evId = randomUUID()
    askNotifyIds.set(ev.uuid + '|' + ev.callId, evId)
    notificationHub.dispatch({
      id: evId,
      kind: 'session-ask',
      title: 'DSH 等待你的回答',
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
        firstUserText,
        questions: ev.questions
      },
      // 点击行为与 session-done 一致：唤起窗口 + 定位到提问的会话
      actions: {
        onClick: () => {
          logger.debug('native notification clicked (session-ask)', { uuid: ev.uuid, callId: ev.callId })
          windowManager.show()
          if (!notificationHub.requestActivate(ev.uuid)) {
            windowManager.activateSessionInWebUi(title, firstUserText, ev.uuid)
          }
        }
      }
    })
  })
}
