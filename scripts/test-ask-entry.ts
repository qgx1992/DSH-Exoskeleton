/**
 * session-ask（询问卡等待通知）测试专用入口：
 * 同一 esbuild bundle 内导出 session-watcher 与 notification-hub/configStore 单例，
 * 保证测试里 configStore.set() / fake webview 通道影响的是 watcher→hub 链路的同一实例
 * （与 test-notify-entry.ts 同构）。
 */
export { sessionWatcher, wireSessionWatcher } from '../src/main/session-watcher'
export { notificationHub } from '../src/main/notification-hub'
export { configStore } from '../src/main/config'
