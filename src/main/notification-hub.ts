/**
 * 通知事件中枢（设计 NOTIFICATION-PLUGIN-DESIGN.md §2 / §4.1）
 *
 * 检测层（session-watcher / dsh-manager 状态 / updater）只产出 NotificationEvent，
 * 本模块负责「显示是策略」：
 *   - Provider 路由：按 notifyChannel 选 webview / native（auto = webview 在线优先）；
 *   - 聚合策略（仅 session-done）：aggregate 模式下同一 session.uuid 在
 *     notifyAggregateWindowMs 内到达的多轮合并为「已完成 N 轮」（按 uuid 不是标题，
 *     防同名会话误合并）；
 *   - 失败降级链：webview 投递失败 → native → 托盘（notify.ts 内部兜底），
 *     每次投递写回执日志（R-26：通知事件去重与投递回执，漏报可查）。
 *
 * 解耦：本模块不 import window-manager。webview 通道由 window-manager 注册
 * （setWebview / markWebviewReady），点击/已读回执经 handleViewMessage 进入。
 */
import { randomUUID } from 'node:crypto'
import { logger } from './logger'
import { configStore } from './config'
import { notify } from './notify'
import type { NotificationEvent, NotificationEventKind } from '../shared/types'

/** 通知 Provider（设计 §3.2）——内置 native / webview 两个实现由 hub 管理 */
export interface NotificationProvider {
  id: 'native' | 'webview' | string
  /** 在线判定（webview provider：桥已握手才投递） */
  ready(): boolean
  /** 投递，返回是否成功（hub 记录回执） */
  handle(ev: NotificationEvent): boolean
}

/** webview 通道（由 window-manager 注册的隔离投递面，不依赖 Electron 具体类型） */
export interface WebviewChannel {
  deliver(ev: NotificationEvent): boolean
}

/** 聚合桶：同一会话窗口内多轮合并 */
interface AggregateBucket {
  start: number
  count: number
  first: NotificationEvent
  latest: NotificationEvent
  timer: NodeJS.Timeout | null
}

class NotificationHub {
  /** ✓ webview 通道：注册的投递面（view attach 时设置；detach 置 null） */
  private webview: WebviewChannel | null = null
  /** ✓ 在线判定：桥握手（页面 __dshExo.ready()）后才投递 */
  private webviewReady = false
  /** ✓ notify:click 处理回调（壳负责唤起窗口；会话激活由插件 ctx.sessions.open 完成） */
  private onClick: ((sessionId?: string) => void) | null = null
  /** ✓ notify:install 处理回调（P2 review 修正：webview 通道的「更新就绪」点击 → 触发安装） */
  private onInstall: (() => void) | null = null
  /** ✓ 聚合桶表：key = session.uuid */
  private aggregate = new Map<string, AggregateBucket>()

  /** window-manager 挂载 dsh view 时注册 webview 通道（detach 时传 null） */
  setWebview(channel: WebviewChannel | null): void {
    this.webview = channel
    if (!channel) this.webviewReady = false
    logger.info('notification webview provider', { online: !!channel, ready: this.webviewReady })
  }

  /** 页面 ready() 握手置位 / view 重建或 detach 复位 */
  markWebviewReady(ready: boolean): void {
    this.webviewReady = ready
    logger.info('notification webview provider ready', { ready })
  }

  /** 壳侧注册 notify:click 处理（window-manager 唤起窗口） */
  setOnClick(fn: ((sessionId?: string) => void) | null): void {
    this.onClick = fn
  }

  /** 壳侧注册 notify:install 处理（P2：webview 通道「更新就绪」点击 → updater.install） */
  setOnInstall(fn: (() => void) | null): void {
    this.onInstall = fn
  }

  /** webview 在线 = 通道已注册 && 已握手（设计 §5.2） */
  webviewOnline(): boolean {
    return !!this.webview && this.webviewReady
  }

  /**
   * 入口：检测层产出的唯一消费点。按配置路由到 Provider / 聚合 / 跳过。
   */
  dispatch(ev: NotificationEvent): void {
    if (!ev || !ev.id || !ev.kind) {
      logger.warn('notification dispatch ignored (malformed event)', ev)
      return
    }
    // 会话完成粒度（检查放这里，一处生效；producer 侧不再重复 gate）
    if (ev.kind === 'session-done') {
      const mode = configStore.get().notifySessionDone
      if (mode === 'off') {
        logger.debug('notification session-done skipped (off)', { id: ev.id })
        return
      }
      if (mode === 'aggregate') {
        this.aggregateSessionDone(ev)
        return
      }
      // per-turn：原样投递（现状行为）
      this.deliver(ev)
      return
    }
    // 服务事件开关（保留原字段语义；在 hub 一处生效）
    if (ev.kind.startsWith('service') && !configStore.get().notifyServiceEvents) {
      logger.debug('notification service event skipped (off)', { id: ev.id, kind: ev.kind })
      return
    }
    this.deliver(ev)
  }

  /**
   * 聚合策略（仅 session-done，设计 §4.1）：窗口内按 session.uuid 合并。
   * 实现：aggregate 模式下延迟投递——窗口起点开桶，窗口结束 flush 一条
   * 「已完成 N 轮」（10 轮连发只产生 1 条聚合通知的验收依据）。
   */
  private aggregateSessionDone(ev: NotificationEvent): void {
    const uuid = ev.session?.uuid
    if (!uuid) {
      // 无 uuid 无法聚合，直接投递（防御）
      this.deliver(ev)
      return
    }
    const windowMs = Math.max(500, Number(configStore.get().notifyAggregateWindowMs) || 5000)
    const now = Date.now()
    const bucket = this.aggregate.get(uuid)
    if (!bucket || now - bucket.start > windowMs) {
      // 新桶（或上个桶已过期，惰性收尾）
      if (bucket) this.flushAggregate(uuid)
      const fresh: AggregateBucket = { start: now, count: 1, first: ev, latest: ev, timer: null }
      fresh.timer = setTimeout(() => this.flushAggregate(uuid), windowMs)
      this.aggregate.set(uuid, fresh)
      logger.debug('notification aggregate bucket opened', { uuid, windowMs })
      return
    }
    bucket.count += 1
    bucket.latest = ev
    logger.debug('notification aggregate bucket append', { uuid, count: bucket.count })
  }

  private flushAggregate(uuid: string): void {
    const bucket = this.aggregate.get(uuid)
    if (!bucket) return
    this.aggregate.delete(uuid)
    if (bucket.timer) clearTimeout(bucket.timer)
    const first = bucket.first
    const count = bucket.count
    if (count <= 1) {
      // 窗口内只有一轮：在窗口结束时原样投递（不丢语义、不拼接正文）。
      // 说明（P1 review 修正）：聚合模式为合并多轮，首轮必须缓冲到窗口结束才 flush，
      // 因此单轮通知也最长延迟一个窗口（默认 5s，见 notifyAggregateWindowMs 配置项说明）。
      this.deliver(bucket.latest)
      return
    }
    const project = first.session?.project
    const title = first.session?.sessionTitle ?? ''
    const body = project
      ? `项目「${project}」· 已完成 ${count} 轮`
      : title
        ? `${title}（已完成 ${count} 轮）`
        : `已完成 ${count} 轮`
    const merged: NotificationEvent = {
      ...first,
      id: randomUUID(),
      body,
      ts: bucket.latest.ts,
      session: first.session
        ? { ...first.session, turn: bucket.latest.session?.turn }
        : undefined
    }
    logger.info('notification aggregate flush', { uuid, count })
    this.deliver(merged)
  }

  /** 路由到实际通道并记录投递回执（R-26） */
  private deliver(ev: NotificationEvent): void {
    const preference = configStore.get().notifyChannel
    const useWebview = preference === 'webview' || (preference === 'auto' && this.webviewOnline())

    if (useWebview) {
      if (!this.webviewOnline()) {
        logger.warn('notification webview requested but offline, degrade native', { id: ev.id, kind: ev.kind })
      } else if (this.execWebview(ev)) {
        logger.info('notification delivered (webview)', { id: ev.id, kind: ev.kind, ts: ev.ts })
        return
      } else {
        logger.warn('notification webview delivery failed, degrade native', { id: ev.id, kind: ev.kind })
      }
    }
    // native 兜底（notify.ts 内部还会降级托盘）
    const ok = this.execNative(ev)
    logger.info('notification delivered (native)', { id: ev.id, kind: ev.kind, ok })
    if (!ok) logger.warn('notification delivery failed (all channels)', { id: ev.id, kind: ev.kind })
  }

  private execWebview(ev: NotificationEvent): boolean {
    if (!this.webview) return false
    try {
      // 剥离主进程侧动作（函数不可跨 IPC；插件侧会话激活由 ctx.sessions.open 完成）
      const payload: NotificationEvent = { ...ev }
      delete (payload as { actions?: unknown }).actions
      return this.webview.deliver(payload)
    } catch (err) {
      logger.warn('notification webview deliver threw', err)
      return false
    }
  }

  private execNative(ev: NotificationEvent): boolean {
    try {
      // P3：notify() 返回真实送达结果（原生通道回执不再恒为 true）
      return notify(ev.title, ev.body, ev.actions?.onClick)
    } catch (err) {
      logger.warn('notification native deliver threw', err)
      return false
    }
  }

  /**
   * 页面 → 壳（webview 桥 ipc 'dsh-exo' 的消息，由 window-manager 作用域转发）：
   * notify:ready 握手 / notify:click 点击（会话类） / notify:install 点击（更新就绪） / notify:seen 回执。
   */
  handleViewMessage(channel: string, payload: unknown): void {
    try {
      if (channel === 'notify:ready') {
        this.markWebviewReady(true)
        return
      }
      if (channel === 'notify:click') {
        const p = payload as { id?: string; sessionId?: string } | undefined
        logger.info('notification click received', { id: p?.id, sessionId: p?.sessionId })
        try {
          this.onClick?.(p?.sessionId)
        } catch (err) {
          logger.warn('notification click handler failed', err)
        }
        return
      }
      if (channel === 'notify:install') {
        const p = payload as { id?: string } | undefined
        logger.info('notification install requested (update-ready click)', { id: p?.id })
        try {
          this.onInstall?.()
        } catch (err) {
          logger.warn('notification install handler failed', err)
        }
        return
      }
      if (channel === 'notify:seen') {
        const p = payload as { id?: string } | undefined
        logger.debug('notification seen received', { id: p?.id })
        return
      }
      logger.debug('notification bridge unknown channel', { channel })
    } catch (err) {
      logger.warn('notification handleViewMessage failed', err)
    }
  }

  /** 测试/自检用：当前通道状态 */
  status(): { webviewOnline: boolean; channel: 'webview' | 'native' } {
    const preference = configStore.get().notifyChannel
    const online = this.webviewOnline()
    const channel = preference === 'webview' || (preference === 'auto' && online) ? 'webview' : 'native'
    return { webviewOnline: online, channel }
  }
}

export const notificationHub = new NotificationHub()
export type { NotificationEventKind }
