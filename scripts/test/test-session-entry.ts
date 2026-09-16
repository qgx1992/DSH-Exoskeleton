/**
 * session-watcher（对话完成通知）测试专用入口：
 * 同一 esbuild bundle 内导出 session-watcher 与 notification-hub/configStore 单例，
 * 保证测试里 configStore.set() / fake webview 通道影响的是 watcher→hub 链路的同一实例
 * （与 test-notify-entry.ts / test-ask-entry.ts 同构）。
 *
 * 用途：断言**生产者实际产出的通知文案**（标题行含项目名、正文不含「项目「X」·」前缀），
 * 而不是只单独测 notificationTitle 辅助函数——文案是在 producer 里拼的。
 */
export { sessionWatcher, wireSessionWatcher } from '../../src/main/session-watcher'
export { notificationHub } from '../../src/main/notification-hub'
export { configStore } from '../../src/main/config'
