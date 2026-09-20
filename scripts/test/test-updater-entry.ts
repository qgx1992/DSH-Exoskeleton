/**
 * updater 测试专用入口：统一转出 updater 与 configStore 单例，
 * 保证测试里 configStore.set() 影响的是 updater 内部读取的同一实例
 * （分开 bundle 会得到两份 configStore，开关改了也不生效 → 假绿）。
 */
export { updater } from '../../src/main/updater'
export { configStore } from '../../src/main/config'
