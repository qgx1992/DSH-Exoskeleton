/**
 * notification-hub 测试专用入口：统一转出 hub 与 configStore 单例，
 * 保证测试里 configStore.set() 影响的是 hub 内部读取的同一实例。
 */
export { notificationHub } from '../src/main/notification-hub'
export { configStore } from '../src/main/config'
// v0.8.2：协议激活（操作中心点击修复）——parseNotifyUrl / activateFromUrl 一并进测试包
export { parseNotifyUrl, activateFromUrl, protocolReady } from '../src/main/notify'
