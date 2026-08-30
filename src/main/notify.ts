/**
 * 原生通知（文档 §4.2.3 / NOTIFICATION-PLUGIN-DESIGN.md）
 * - 服务就绪 / 服务异常 / 崩溃重启 / 会话完成 等场景发送 Windows 原生通知
 * - 系统不支持时自动降级为托盘气泡
 * - 返回 boolean：是否真正送达某通道（P3 review 修正：native 投递回执不再恒为 true，
 *   notification-hub 的 R-26「漏报可查」对原生通道才真实）
 *
 * Windows toast 激活修复（v0.8.2，现场取证 + electron/electron#32585 确认）：
 * - Electron 34 的 Windows toast 没有可用的激活机制：弹出通知点击能触发实例 click
 *   （Electron 内部兜底），但通知进入「操作中心（Action Center）」后再点击
 *   不会产生任何事件，toast 也不会被系统移除（用户复现：通知栏里残留的会话完成
 *   通知再点无效、点完不消失）。
 * - 修复：自定义 toastXml 协议激活——`activationType="protocol"` + `launch="dsh-exo://notify?…"`。
 *   点击（无论弹出还是操作中心、应用运行中还是冷启动）都会拉起 dsh-exo:// 协议：
 *     · 应用运行中 → second-instance argv 转发 → activateFromUrl() 执行原点击动作 + close() 移除；
 *     · 冷启动 → process.argv 携带 URL → 启动后 activateFromUrl() 兜底（唤起窗口 + 定位会话）。
 *   Windows 在协议激活成功后会自行把该 toast 从操作中心移除（解决「点完不消失」）。
 * - 已投递通知注册表：保留 Notification 实例引用（防 GC），激活/过期后 close()
 *   从操作中心移除；注册表有上限 + 过期清扫，防长期运行内存增长。
 * - 兜底链：协议注册失败 / 无 meta 的通知仍用普通 toast（实例 click 事件兜底），
 *   行为与旧版一致；Notification 不支持时降级托盘气泡。
 */
import { app, Notification } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'

/** dsh-exo://notify?… 协议 URL 的解析结果 */
export interface NotifyUrlPayload {
  id?: string
  session?: string
  kind?: string
}

/** 投递辅助元数据（供协议激活关联回原事件） */
export interface NotifyMeta {
  id?: string
  kind?: string
  sessionUuid?: string
}

/** 已投递通知注册表条目（保留实例引用，防 GC 导致操作中心 toast 无法移除/关联） */
interface ShownRecord {
  n: Notification
  evId: string
  sessionUuid?: string
  kind?: string
  onClick?: () => void
  shownAt: number
}

const PROTOCOL = 'dsh-exo'
/** 协议是否注册成功（决定 toast 是否使用协议激活；失败则退回普通 toast） */
let protocolRegistered = false
/** 已投递通知：key = 事件 id */
const shown = new Map<string, ShownRecord>()
/** 注册表上限（超过逐出最旧，最坏只影响「操作中心再点一次」的精确动作，不影响投递） */
const MAX_SHOWN = 50
/** 注册表过期时间：超过即 close() 并从操作中心移除 */
const SHOWN_TTL_MS = 60 * 60 * 1000

/**
 * 每次启动注册 dsh-exo:// 协议（幂等）。
 * dev 模式需显式传 electron.exe + 应用入口路径（官方 deep-link 教程写法）；
 * 打包版直接注册当前 exe。
 */
export function initNotificationProtocol(): boolean {
  try {
    const appPath = process.argv[1]
    const ok = app.isPackaged || !appPath
      ? app.setAsDefaultProtocolClient(PROTOCOL)
      : app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(appPath)])
    protocolRegistered = ok
    logger.info('notification protocol registered', { protocol: PROTOCOL, ok, packaged: app.isPackaged })
  } catch (err) {
    protocolRegistered = false
    logger.warn('notification protocol registration failed', err)
  }
  return protocolRegistered
}

/** 协议注册状态（诊断/自检用） */
export function protocolReady(): boolean {
  return protocolRegistered
}

/** 解析 dsh-exo://notify?… URL（兼容 dsh-exo://notify 与 dsh-exo:notify 两种形态） */
export function parseNotifyUrl(raw: string): NotifyUrlPayload | null {
  try {
    const u = new URL(String(raw).trim())
    if (u.protocol !== `${PROTOCOL}:`) return null
    const seg = (u.hostname || u.pathname.replace(/^\//, '')).toLowerCase()
    if (seg !== 'notify') return null
    const p: NotifyUrlPayload = {}
    const id = u.searchParams.get('id')
    const session = u.searchParams.get('session')
    const kind = u.searchParams.get('kind')
    if (id) p.id = id
    // 会话 ID 白名单校验（与 sessions.ts isSessionId 同规则，防协议 URL 注入）
    if (session && /^[A-Za-z0-9_-]+$/.test(session)) p.session = session
    if (kind) p.kind = kind
    return p.id || p.session ? p : null
  } catch {
    return null
  }
}

/**
 * 协议激活入口（原生 toast 点击：弹出通知 / 操作中心 / 冷启动统一到达）。
 * - 命中注册表（应用运行中、未过期）：执行原点击动作 + close() 从操作中心移除，
 *   返回 handled=true；
 * - 未命中（冷启动 / 已过期）：返回 payload，由调用方（index.ts）做唤起窗口 + 会话兜底。
 */
export function activateFromUrl(raw: string): { handled: boolean; payload: NotifyUrlPayload | null } {
  const payload = parseNotifyUrl(raw)
  if (!payload) return { handled: false, payload: null }
  if (payload.id) {
    const rec = shown.get(payload.id)
    if (rec) {
      logger.info('notification activated (protocol, live)', { id: payload.id, session: rec.sessionUuid, kind: rec.kind })
      try {
        rec.onClick?.()
      } catch (err) {
        logger.warn('notification activation handler failed', err)
      }
      try {
        rec.n.close()
      } catch {
        /* 忽略：toast 已不在 */
      }
      shown.delete(payload.id)
      return { handled: true, payload }
    }
  }
  logger.info('notification activated (protocol, cold)', { payload })
  return { handled: false, payload }
}

/** XML 转义（launch 属性与 toast 文本共用） */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 构造 dsh-exo://notify?… 启动 URL（查询参数做 URL 编码） */
function buildLaunchUrl(meta: NotifyMeta): string {
  const params = new URLSearchParams()
  if (meta.id) params.set('id', meta.id)
  if (meta.kind) params.set('kind', meta.kind)
  if (meta.sessionUuid) params.set('session', meta.sessionUuid)
  return `${PROTOCOL}://notify?${params.toString()}`
}

/** Windows toast XML：协议激活（整条点击 = 拉起 dsh-exo:// 协议） */
function buildToastXml(title: string, body: string, launch: string): string {
  return [
    `<toast activationType="protocol" launch="${esc(launch)}">`,
    '  <visual>',
    '    <binding template="ToastText02">',
    `      <text id="1">${esc(title)}</text>`,
    `      <text id="2">${esc(body)}</text>`,
    '    </binding>',
    '  </visual>',
    '</toast>'
  ].join('\n')
}

/** 注册表清扫：过期条目 close() 移除 + 超上限逐出最旧 */
function sweepShown(): void {
  const now = Date.now()
  for (const [k, rec] of shown) {
    if (now - rec.shownAt > SHOWN_TTL_MS) {
      try {
        rec.n.close()
      } catch {
        /* 忽略 */
      }
      shown.delete(k)
    }
  }
  while (shown.size > MAX_SHOWN) {
    let oldest: string | null = null
    let oldestAt = Infinity
    for (const [k, rec] of shown) {
      if (rec.shownAt < oldestAt) {
        oldestAt = rec.shownAt
        oldest = k
      }
    }
    if (oldest) {
      try {
        shown.get(oldest)?.n.close()
      } catch {
        /* 忽略 */
      }
      shown.delete(oldest)
    }
  }
}

/**
 * 发送原生通知。
 * @param meta 关联元数据（事件 id / kind / 会话 uuid）——提供后 toast 走协议激活，
 *   点击（含操作中心、冷启动）可精确回到原事件并执行 onClick。
 */
export function notify(title: string, body: string, onClick?: () => void, meta?: NotifyMeta): boolean {
  try {
    if (Notification.isSupported()) {
      const evId = meta?.id || randomUUID()
      // 协议激活 toast（toastXml 全权接管显示与激活）：实测（E2E 验证）——
      // 一个真实的 toast 点击会同时触发 (a) Electron 实例 click 事件 和
      // (b) Windows 拉起 dsh-exo:// 协议 URL。若两条路径都挂 onClick 会造成
      // 双重处理（会话被激活两次）。因此协议 toast 只走协议路径
      // （second-instance → activateFromUrl 命中注册表 → 回放 onClick），
      // 不再挂实例 click；普通 toast（协议注册失败/无 meta）保留实例 click 兜底。
      const useProtocol = protocolRegistered && !!meta
      let n: Notification
      if (useProtocol) {
        try {
          n = new Notification({
            toastXml: buildToastXml(title, body, buildLaunchUrl(meta as NotifyMeta)),
            silent: false
          })
        } catch (err) {
          logger.warn('notification toastXml failed, fallback standard', err)
          n = new Notification({ title, body, silent: false })
        }
      } else {
        n = new Notification({ title, body, silent: false })
      }

      const rec: ShownRecord = { n, evId, sessionUuid: meta?.sessionUuid, kind: meta?.kind, onClick, shownAt: Date.now() }
      if (!useProtocol) {
        // 实例 click：普通 toast（协议注册失败/无 meta）的兜底点击通道
        n.on('click', () => {
          logger.debug('notification clicked (instance)', { evId })
          try {
            rec.onClick?.()
          } catch (err) {
            logger.warn('notification click handler failed', err)
          }
          try {
            n.close()
          } catch {
            /* 忽略 */
          }
          shown.delete(evId)
        })
      }
      // 注意：close 事件（超时/用户关闭）不删注册表——toast 超时后仍留在操作中心，
      // 保留记录才能让「再点一次」精确回放 onClick；由 sweep 按 TTL 统一清理。
      n.on('failed', (_e, err) => {
        logger.warn('notification failed', err)
        shown.delete(evId)
      })
      sweepShown()
      shown.set(evId, rec)
      n.show()
      logger.debug('notification sent', { title, evId, protocol: protocolRegistered })
      return true
    }
    // 降级：托盘气泡
    const { getTray } = require('./tray') as typeof import('./tray')
    const tray = getTray()
    if (tray) {
      tray.displayBalloon({ title, content: body.slice(0, 255) })
      return true
    }
    return false
  } catch (err) {
    logger.warn('notification failed', err)
    return false
  }
}

export { Notification }
