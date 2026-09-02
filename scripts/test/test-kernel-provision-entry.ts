/**
 * kernel-provision 测试专用入口：转出可测单元
 * - ConfigStore 类：验证 config 全新创建 / 老配置迁移 / 显式 false 保留三种语义
 * - needsDefaultKernelProvision：预置守卫（纯函数）
 * - DEFAULT_KERNEL_VERSION / KernelManager.isValidVersion：默认版本常量格式
 * esbuild 打包为 scripts/out/kernel-provision.cjs，供 test-kernel-provision.cjs 断言
 */
export { ConfigStore } from '../../src/main/config'
export { needsDefaultKernelProvision } from '../../src/main/kernel-provision'
export { DEFAULT_KERNEL_VERSION } from '../../src/shared/kernel-defaults'
export { KernelManager } from '../../src/main/kernel-manager'
