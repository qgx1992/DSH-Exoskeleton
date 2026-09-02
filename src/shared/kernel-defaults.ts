/**
 * @shared 首启默认内核版本（设计 docs/KERNEL-MANAGER-DESIGN.md 阶段 D）
 * - 全新安装（config 为首次生成、用户未做过任何内核选择）时，
 *   首次启动自动安装该版本并设为默认内核（kernel-provision.ts）
 * - 发布注意：壳发版前须确认该版本已发布到 npm registry
 *   （@deepseek-ai/dsh，官方源或 npmmirror 镜像均可见），
 *   否则预置会在每次启动时安装失败并静默重试、回退系统 dsh
 */
export const DEFAULT_KERNEL_VERSION = '0.1.2-alpha.5'
