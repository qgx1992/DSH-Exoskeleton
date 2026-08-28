/**
 * DSH Web 视图专用预加载桥（设计 NOTIFICATION-PLUGIN-DESIGN.md §5）
 *
 * 与主壳 renderer 的 preload（src/preload/index.ts）**分开**：不同 world、
 * 不同 API，互不干扰。只给 dsh web（WebContentsView 承载，sandbox +
 * contextIsolation）暴露最小白名单 `window.__dshExo`，不含任意 IPC 透传。
 *
 * 新增不变量 R-27：webview 预加载只暴露 __dshExo 白名单，非本壳 renderer
 * 一律不可达管理 IPC。
 *
 * 通道约定：
 *   - 主 → 页面：view.webContents.send('dsh-notify:event', ev)
 *   - 页面 → 主：ipcRenderer.send('dsh-exo', channel, payload)
 *     （主进程用 view.webContents.on('ipc-message') 接收，作用域限定该 view，
 *     不污染 ipcMain 全局通道）
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { NotificationEvent } from '../shared/types'

const PUSH_CHANNEL = 'dsh-notify:event'
const SEND_CHANNEL = 'dsh-exo'

type EventCallback = (ev: NotificationEvent) => void

const listeners = new Set<EventCallback>()

// 订阅壳推送的通知事件（主 → 页面），返回取消函数
function onEvent(cb: EventCallback): () => void {
  if (typeof cb !== 'function') return () => {}
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

ipcRenderer.on(PUSH_CHANNEL, (_event, ev: unknown) => {
  // 页面侧异常全部静默（设计 §5.3），不阻塞主进程
  for (const cb of [...listeners]) {
    try {
      cb(ev as NotificationEvent)
    } catch {
      /* 静默忽略单个订阅者异常 */
    }
  }
})

// 页面 → 壳（notify:ready 握手 / notify:click / notify:install / notify:seen）
function send(channel: string, payload: unknown): void {
  try {
    ipcRenderer.send(SEND_CHANNEL, channel, payload ?? {})
  } catch {
    /* 静默 */
  }
}

// 握手：插件就绪后才投递，防"事件先于页面就绪被丢"（设计 §5.2）
function ready(): void {
  send('notify:ready', {})
}

// P4 review 修正：不再经 invoke 取壳版本（app:getVersion 在 ipcMain 全局注册，
// 页面可达，与 R-27「非本壳 renderer 不可达管理 IPC」不符）。版本信息不通过桥下放；
// 调试信息改由推送事件载荷携带。appInfo 仅保留契约形状，供插件判断桥在线。
function appInfo(): { version: string } {
  return { version: '' }
}

// R-27：最小白名单，仅 __dshExo
contextBridge.exposeInMainWorld('__dshExo', {
  onEvent,
  send,
  ready,
  appInfo
})
