/**
 * pnpm 提供器（插件管理自愈）
 *
 * 背景：`dsh plugin --profile web add|remove` 内部会**裸调 `pnpm` 命令**去
 * ~/.dsh/profiles/web 装依赖，而 DSH 内核（@deepseek-ai/dsh）不自带 pnpm。
 * 若本机 PATH 上没有 pnpm（常见于「零门槛」装机——用户只用桌面端内置 Node 运行时、
 * 从没手动装过 pnpm），插件安装/卸载会以 exit 1 失败，面板只显示模糊的
 * 「安装失败（exit 1）」。日志定位：`'pnpm' 不是内部或外部命令` +
 * `dsh: pnpm failed in profile directory ...`。
 *
 * 自愈策略（与内核安装一致，走运行时自带 npm，一次性联网后永久离线可用）：
 * 1. 系统/PATH 已有可用 pnpm → 直接用，无需注入；
 * 2. 否则用嵌入式 Node 运行时的 npm 把 pnpm 装进 userData/pnpm 隔离前缀
 *    （不污染系统全局，符合「内置 pnpm、离线可用」设计目标）；
 * 3. 用「硬编码 node 路径」的 pnpm.cmd 覆盖 npm 生成的 shim（npm 生成的 shim
 *    会回退到 PATH 上的 node，零门槛机可能没有）→ dsh 就能通过子进程 PATH
 *    找到裸命令 pnpm。
 *
 * 为什么不用 corepack：运行时自带的 corepack 只是 pnpm.js 存根，pnpm 未缓存时
 * 会强制联网下载且受 COREPACK_ENABLE_DOWNLOAD_PROMPT 影响，离线不可靠；
 * 用 npm 实装到隔离前缀更确定。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { logger } from './logger'
import { configStore } from './config'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** 隔离前缀：userData/pnpm（pnpm 本体 + pnpm.cmd shim） */
function provisionDir(): string {
  return path.join(app.getPath('userData'), 'pnpm')
}

/** 该目录下是否存在可用的 pnpm 命令入口（npm 全局布局：<dir>/pnpm.cmd） */
function pnpmCmdAt(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, 'pnpm.cmd')) && fs.statSync(path.join(dir, 'pnpm.cmd')).size > 0
  } catch {
    return false
  }
}

/** R-13: 异步执行命令取 stdout（探测 pnpm 用，避免同步阻塞主进程） */
function execFileAsync(cmd: string, args: string[], timeoutMs = 8_000): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout) => {
      if (err) resolvePromise(null)
      else resolvePromise(stdout)
    })
  })
}

/** 执行 node + args，返回退出码/输出（用于 npm 安装 pnpm；R-13 异步） */
function runNode(
  nodeExe: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(nodeExe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* noop */
      }
      resolvePromise({ code: -1, stdout, stderr: '命令超时（>' + timeoutMs / 1000 + 's），已终止' })
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: err.message })
    })
  })
}

// 并发防护：一次性 pnpm 预置（同一进程内只跑一次安装；插件操作本身已有 pluginOpBusy 串行化，
// 但 execDsh 也可能被其他调用触发，这里再加一层保护）
let provisionInFlight: Promise<boolean> | null = null

/** 预置 pnpm 到 userData/pnpm（用嵌入式 Node 运行时的 npm 全局安装；一次性联网） */
async function provisionPnpm(nodeExe: string): Promise<boolean> {
  const prefix = provisionDir()
  const npmCli = path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(npmCli)) {
    logger.warn('pnpm provision skipped: npm-cli.js not found next to node', { nodeExe })
    return false
  }
  try {
    fs.mkdirSync(prefix, { recursive: true })
  } catch {
    /* noop */
  }
  const registry = configStore.get().kernelRegistry || DEFAULT_REGISTRY
  logger.info('pnpm not found, provisioning via embedded npm', { prefix, registry })
  // 与内核安装一致：node 直接跑 npm-cli.js（避免 .cmd 的 cmd.exe 引号问题）
  const r = await runNode(
    nodeExe,
    [npmCli, 'install', '-g', 'pnpm', '--prefix', prefix, '--no-audit', '--no-fund', '--registry', registry],
    180_000
  )
  if (r.code !== 0) {
    logger.warn('pnpm provision failed', { code: r.code, stderr: (r.stderr || r.stdout).slice(0, 500) })
    return false
  }
  // npm 生成的 <prefix>/pnpm.cmd 已指向实际 pnpm 入口：pnpm 12 是原生二进制（bin=pnpm.exe，
  // 自包含、不依赖 PATH 上的 node），旧版 node 型 pnpm 也有对应 shim。直接用它即可，
  // 无需再覆盖。
  if (!pnpmCmdAt(prefix)) {
    logger.warn('pnpm provision: pnpm.cmd not found after install', { prefix })
    return false
  }
  logger.info('pnpm provisioned', { prefix })
  return true
}

/**
 * 确保有可用的 pnpm，返回需要注入到子进程 PATH 的目录（null = pnpm 已全局可用/无法提供）。
 * 优先级：已预置的 userData/pnpm → 系统/PATH 已有 → 用嵌入式 npm 预置一次。
 */
export async function ensurePnpm(
  nodeExe: string
): Promise<{ pnpmDir: string | null; provisioned: boolean }> {
  // 1) 已预置 → 注入其目录
  const prov = provisionDir()
  if (pnpmCmdAt(prov)) {
    return { pnpmDir: prov, provisioned: false }
  }
  // 2) 系统/PATH 已有 pnpm → dsh 继承的 PATH 已能找到，无需注入
  try {
    const found = await execFileAsync('where', ['pnpm'])
    if (found && found.trim()) {
      return { pnpmDir: null, provisioned: false }
    }
  } catch {
    /* noop */
  }
  // 3) 预置（并发防护）
  if (!provisionInFlight) {
    const p = provisionPnpm(nodeExe)
    provisionInFlight = p
    void p
      .catch(() => false)
      .then(() => {
        provisionInFlight = null
      })
  }
  let ok = false
  try {
    ok = await provisionInFlight
  } catch {
    ok = false
  }
  if (ok && pnpmCmdAt(prov)) return { pnpmDir: prov, provisioned: true }
  return { pnpmDir: null, provisioned: false }
}
