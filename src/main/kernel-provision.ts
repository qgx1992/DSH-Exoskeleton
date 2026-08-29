/**
 * 首启默认内核预置（设计 docs/KERNEL-MANAGER-DESIGN.md 阶段 D）
 * - 全新安装（config 首次生成、用户未做过任何内核选择）首次启动时，
 *   自动安装 DEFAULT_KERNEL_VERSION 并设为默认内核——「装好即用」
 * - 一次性：成功后写 config.defaultKernelProvisioned；失败不落标记，下次启动重试
 * - 老用户（升级前已有 config）由 config.load 迁移直接置为已完成，绝不打扰
 * - 全新机器无 Node 时先自动下载内置 Node 运行时（零门槛链路，进度经
 *   runtime:progress / kernels:progress 推送到内核面板）
 */
import { logger } from './logger'
import { configStore } from './config'
import { dshManager } from './dsh-manager'
import { kernelManager } from './kernel-manager'
import { runtimeManager } from './runtime-manager'
import { DEFAULT_KERNEL_VERSION } from '../shared/kernel-defaults'
import type { AppConfig } from '../shared/types'

/**
 * 是否需要预置默认内核（纯函数，可独立测试）：
 * - 已完成预置 / 非 managed 模式 → 否
 * - 用户已表达过内核偏好（默认版本已设 / 任一档案绑定 / 已装任何托管内核）→ 否
 *   （含「预置安装成功但中途崩溃未落标记」之外的干扰场景；该场景由
 *   provisionDefaultKernel 收尾分支自愈）
 */
export function needsDefaultKernelProvision(cfg: AppConfig, installedVersions: string[]): boolean {
  if (cfg.defaultKernelProvisioned) return false
  if (cfg.kernelMode !== 'managed') return false
  if (cfg.defaultKernelVersion) return false
  if ((cfg.profiles ?? []).some((p) => p.kernelVersion)) return false
  if (installedVersions.length > 0) return false
  return true
}

/**
 * 内核安装依赖 Node：内置运行时与系统 Node 都没有时，先自动下载内置运行时。
 * 返回 false 时继续尝试安装也无妨——install() 会给出明确的「未找到 Node」错误
 * 并走「失败不落标记、下次重试」路径。
 */
async function ensureNodeRuntime(): Promise<boolean> {
  const st = await runtimeManager.status()
  if (st.installed || st.systemNode) return true
  logger.info('no node runtime available, downloading embedded runtime for default kernel provision')
  const r = await runtimeManager.download()
  if (!r.ok) {
    logger.warn('embedded runtime download failed (kernel provision will retry next launch)', { error: r.error })
    return false
  }
  return true
}

/**
 * 首启默认内核预置（幂等；由主进程 bootstrap 触发，不阻塞 UI）。
 * 安装期间服务可先用系统 dsh 兜底运行，预置完成后自动切换重启。
 */
export async function provisionDefaultKernel(): Promise<void> {
  try {
    kernelManager.init()
    const installed = kernelManager.listInstalled().map((k) => k.version)
    const cfg = configStore.get()

    if (needsDefaultKernelProvision(cfg, installed)) {
      // 全新机器无 Node：先备内置运行时（失败则 install 报错并下次重试）
      await ensureNodeRuntime()
      const r = await kernelManager.install(DEFAULT_KERNEL_VERSION, cfg.kernelRegistry || undefined)
      if (!r.ok) {
        logger.warn('default kernel install failed, will retry on next launch', {
          version: DEFAULT_KERNEL_VERSION,
          error: r.error
        })
        return // 不落标记：下次启动自动重试
      }
    }

    // ---- 收尾：落一次性标记；若默认内核已装且用户没有其他选择 → 指向它 ----
    const latest = configStore.get()
    if (latest.defaultKernelProvisioned) return
    const installedNow = kernelManager.listInstalled().map((k) => k.version)
    const patches: Partial<AppConfig> = { defaultKernelProvisioned: true }
    const profileBound = (latest.profiles ?? []).some((p) => p.kernelVersion)
    // 重读 config 后再决定：用户在安装期间手动设过默认/绑定档案 → 尊重用户，不覆盖
    if (!latest.defaultKernelVersion && !profileBound && installedNow.includes(DEFAULT_KERNEL_VERSION)) {
      patches.defaultKernelVersion = DEFAULT_KERNEL_VERSION
    }
    configStore.set(patches)
    logger.info('default kernel provisioned', {
      version: DEFAULT_KERNEL_VERSION,
      setDefault: !!patches.defaultKernelVersion
    })

    // 默认内核生效：服务运行/启动中 → 换内核重启；
    // 此前启动失败（如全新机器无系统 dsh 报「未找到 dsh」）→ 装好内核后直接拉起
    if (patches.defaultKernelVersion) {
      const st = dshManager.getState().status
      if (st === 'running' || st === 'starting') {
        await dshManager.restart()
      } else if (configStore.get().autoStartService !== false) {
        await dshManager.start()
      }
    }
  } catch (err) {
    // 预置异常不影响应用运行：下次启动重试
    logger.warn('default kernel provision error', err instanceof Error ? err.message : String(err))
  }
}
