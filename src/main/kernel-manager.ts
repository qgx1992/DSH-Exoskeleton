/**
 * DSH 内核版本管理 · 多内核共存（设计文档 docs/KERNEL-MANAGER-DESIGN.md，阶段 A）
 * - 托管内核仓库：userData/kernels/<version>/ 各版本隔离
 * - 获取：npm registry（tarball + sha512 完整性校验），依赖由 npm 安装（含原生模块 prebuild）
 * - 路由：config.defaultKernelVersion（kernelMode=managed）→ 系统 dsh 兜底
 * - 运行必须使用系统 Node（原生模块 ABI 约束），阶段 B 引入内置 Node 运行时
 */
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { logger } from './logger'
import { configStore } from './config'
import { runtimeManager } from './runtime-manager'
import { compareVersions, isRcVersion } from '../shared/version'
import type { KernelBootHealth, KernelInfo, KernelProgress, KernelQuota, KernelRemoteVersion, KernelUpdateInfo, SaveResult } from '../shared/types'

const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'
/** registry 根（install --registry 参数需要根 URL，不是包元数据 URL） */
const REGISTRY_ROOT = 'https://registry.npmjs.org'
const PACKAGE = '@deepseek-ai/dsh'
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
/**
 * 卸载回收站后缀：卸载先「改名」再「删除」（见 uninstall）。
 * Windows 上被进程映射的 DLL 会拒绝 unlink（EPERM/EBUSY），但**不阻止父目录改名**，
 * 改名因此能把「卸载」这个用户动作与「删除文件」这个可能失败的物理操作解耦。
 */
const TRASH_SUFFIX = '.deleting'

interface KernelMeta {
  version: string
  dir: string
  status: KernelInfo['status']
  installedAt: number | null
  size: number
  integrity: string | null
  error: string | null
  /** R-24: 启动健康状态（kernels.json 持久化；旧索引缺字段按 untested 归一） */
  bootHealth: KernelBootHealth
  failReason: string | null
  compatPatch: string | null
}

interface KernelIndex {
  kernels: Record<string, KernelMeta>
}

export class KernelManager extends EventEmitter {
  private kernelsDir = ''
  private index: KernelIndex = { kernels: {} }
  private nodeExe: string | null = null
  /** H4: 正在安装/下载中的版本（并发防护：同一版本禁止并发 install） */
  private busyVersions = new Set<string>()
  /** 正在后台清理的 .deleting 目录（避免对同一目录重复触发删除） */
  private purging = new Set<string>()
  /** R-15: 内置运行时目录大小缓存（30s TTL，避免 quota() 每次全量同步扫描） */
  private runtimeSizeCache: { at: number; mb: number } | null = null
  /** 待回收（.deleting）目录占用缓存（30s TTL，同 runtimeSizeCache 理由） */
  private trashSizeCache: { at: number; mb: number } | null = null
  /** 回收站占用后台测量进行中标志（防止面板反复拉取时并发重扫） */
  private trashMeasuring = false

  init(): void {
    this.kernelsDir = path.join(app.getPath('userData'), 'kernels')
    fs.mkdirSync(this.kernelsDir, { recursive: true })
    this.loadIndex()
  }

  private indexFile(): string {
    return path.join(this.kernelsDir, 'kernels.json')
  }

  private loadIndex(): void {
    try {
      if (fs.existsSync(this.indexFile())) {
        const parsed = JSON.parse(fs.readFileSync(this.indexFile(), 'utf-8')) as KernelIndex
        // R-24 兼容：旧 kernels.json 无 bootHealth 等字段 → 归一为 untested
        for (const meta of Object.values(parsed.kernels)) {
          if (!meta.bootHealth) meta.bootHealth = 'untested'
          if (meta.failReason === undefined) meta.failReason = null
          if (meta.compatPatch === undefined) meta.compatPatch = null
        }
        this.index = parsed
      }
    } catch (err) {
      logger.warn('kernels index load failed', err)
      this.index = { kernels: {} }
    }
  }

  private persistIndex(): void {
    try {
      // R-3: 原子写入（临时文件 + rename），避免崩溃/断电写坏 kernels.json
      const tmp = this.indexFile() + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2), 'utf-8')
      fs.renameSync(tmp, this.indexFile())
    } catch (err) {
      logger.error('kernels index persist failed', err)
    }
  }

  /** 安全规范化 && 校验版本号 */
  static isValidVersion(v: string): boolean {
    return VERSION_RE.test(v.trim())
  }

  static safeDirName(v: string): string {
    return v.trim().replace(/[^0-9A-Za-z.+-]/g, '_')
  }

  binJsFor(version: string): string | null {
    if (!VERSION_RE.test(version)) return null
    const p = path.join(this.kernelsDir, version, 'node_modules', PACKAGE, 'lib', 'bin.js')
    return fs.existsSync(p) ? p : null
  }

  /** 当前应使用的托管内核（已安装且被选为默认） */
  getActiveVersion(defaultVersion: string | null): string | null {
    if (!defaultVersion) return null
    const meta = this.index.kernels[defaultVersion]
    if (meta?.status === 'installed' && this.binJsFor(defaultVersion)) return defaultVersion
    return null
  }

  /**
   * 已安装内核列表（面板主数据源）。
   * 包含 broken 项：它们不是可用内核，但占着磁盘、且是用户「卸载不了」的直接受害者，
   * 必须列出来并提供卸载入口（否则界面上看不见、磁盘上删不掉 = 永远泄漏）。
   * 可用性判定仍以 status === 'installed' 为准（getActiveVersion 与各处 setDefault/trial
   * 门禁都不接受 broken）。
   */
  listInstalled(): KernelInfo[] {
    return Object.values(this.index.kernels)
      .filter((k) => k.status === 'installed' || k.status === 'broken')
      .map((k) => this.toInfo(k))
      .sort((a, b) => {
        // 可用内核在前，损坏的排到最后，避免脏项抢视线
        const bad = (k: KernelInfo): number => (k.status === 'broken' ? 1 : 0)
        if (bad(a) !== bad(b)) return bad(a) - bad(b)
        return (b.installedAt ?? 0) - (a.installedAt ?? 0)
      })
  }

  /** 可用内核版本（排除 broken）——门禁类判断用这个，避免把半个内核当作可用 */
  listUsable(): KernelInfo[] {
    return this.listInstalled().filter((k) => k.status === 'installed')
  }

  private toInfo(k: KernelMeta): KernelInfo {
    return {
      version: k.version,
      dir: k.dir,
      status: k.status,
      installedAt: k.installedAt,
      size: k.size,
      integrity: k.integrity,
      error: k.error,
      bootHealth: k.bootHealth ?? 'untested',
      failReason: k.failReason ?? null,
      compatPatch: k.compatPatch ?? null
    }
  }

  /**
   * R-24: 记录内核启动健康状态（试启动门禁结果 / 崩溃回滚）。
   * ok 且带补丁时由 setCompatPatch 同步记录补丁文件路径。
   */
  setBootHealth(version: string, health: KernelBootHealth, reason?: string | null): void {
    this.init()
    const meta = this.index.kernels[version]
    if (!meta) return
    meta.bootHealth = health
    meta.failReason = health === 'failed' ? (reason ?? null) : null
    this.persistIndex()
    logger.info('kernel boot health', { version, health, reason: meta.failReason })
  }

  /** 记录该版本当前使用的兼容补丁文件（null = 无补丁） */
  setCompatPatch(version: string, patch: string | null): void {
    this.init()
    const meta = this.index.kernels[version]
    if (!meta) return
    meta.compatPatch = patch
    this.persistIndex()
  }

  /**
   * 重建第一锚点（profile 私有 node_modules/@deepseek-ai）的官方包链接 → 指定内核。
   *
   * 背景（版本混杂修复）：Exoskeleton 托管内核场景下，host 组合从内核 store 解析官方包；
   * 而第一锚点是 pnpm 管理的目录，dsh 的 heal 只维护第二锚点（profiles/node_modules），
   * 这里残留指向 npm 全局或旧内核的 symlink 会让同一进程出现双模块实例
   * （模块内 Symbol 分裂，如 @deepseek-ai/dsh-scope 的 kScope → preset 工具注册 scope 判定
   * 失效 → 切换 agent preset 报 "tool xxx is already registered"）。
   * 升级/切换内核后必须把这里的官方包链接统一指到新内核，否则版本混杂复发。
   *
   * 只处理 symlink/junction（不碰 pnpm 安装的真实目录）；目标包在内核中不存在时跳过并告警。
   */
  relinkProfileAnchor(kernelVersion: string): { relinked: string[]; skipped: string[] } {
    const relinked: string[] = []
    const skipped: string[] = []
    try {
      const cfg = configStore.get()
      const dshHome = cfg.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const anchorDir = path.join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai')
      const kernelDir = path.join(this.kernelsDir, KernelManager.safeDirName(kernelVersion))
      if (!fs.existsSync(anchorDir) || !fs.existsSync(kernelDir)) return { relinked, skipped }
      const entries = fs.readdirSync(anchorDir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isSymbolicLink()) continue // 只处理链接，pnpm 安装的真实目录不碰
        const linkPath = path.join(anchorDir, e.name)
        let target: string
        try {
          target = fs.readlinkSync(linkPath)
        } catch {
          continue
        }
        // 已指向目标内核 → 幂等跳过
        if (target.includes(kernelDir)) continue
        // dsh 官方管理的链接（profile 内部 module-fallback 体系，如指向
        // ~/.dsh/profiles/web/.dsh-module-fallback/…）→ 不处理，它们不是版本混杂来源
        if (target.includes('.dsh-module-fallback') || target.includes(path.sep + 'profiles' + path.sep)) continue
        const targetPkg = this.resolveKernelPackagePath(kernelDir, e.name)
        if (!targetPkg) {
          skipped.push(e.name)
          logger.warn('relink profile anchor: package not found in kernel, skipped', { pkg: e.name, kernelVersion })
          continue
        }
        try {
          fs.rmSync(linkPath, { force: true })
          // Windows 用 junction（免管理员/开发者模式，与现有链接一致）；POSIX 用目录符号链接
          fs.symlinkSync(targetPkg, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
          relinked.push(e.name)
          logger.info('relink profile anchor', { pkg: e.name, from: target, to: targetPkg })
        } catch (err) {
          logger.warn('relink profile anchor failed', { pkg: e.name, err })
          skipped.push(e.name)
        }
      }
    } catch (err) {
      logger.warn('relink profile anchor error', err)
    }
    return { relinked, skipped }
  }

  /**
   * 快照第一锚点官方包链接（试启动门禁用）：返回当前 symlink 的 {name, target}。
   * 试启动后 {@link restoreProfileAnchor} 精确还原，保证门禁对链接完全无副作用
   * （恢复 relink 会改变路径形式，如 store 布局↔扁平，可能让运行中进程的已加载模块
   * 与新加载模块路径不一致 → 双模块实例）。
   */
  snapshotProfileAnchor(): Array<{ name: string; target: string }> {
    const out: Array<{ name: string; target: string }> = []
    try {
      const cfg = configStore.get()
      const dshHome = cfg.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const anchorDir = path.join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai')
      if (!fs.existsSync(anchorDir)) return out
      for (const e of fs.readdirSync(anchorDir, { withFileTypes: true })) {
        if (!e.isSymbolicLink()) continue
        try {
          out.push({ name: e.name, target: fs.readlinkSync(path.join(anchorDir, e.name)) })
        } catch {
          /* noop */
        }
      }
    } catch {
      /* noop */
    }
    return out
  }

  /** 按快照精确还原第一锚点链接（先删现有链接，再按快照目标重建；幂等） */
  restoreProfileAnchor(snapshot: Array<{ name: string; target: string }>): void {
    try {
      const cfg = configStore.get()
      const dshHome = cfg.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const anchorDir = path.join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai')
      if (!fs.existsSync(anchorDir)) return
      for (const s of snapshot) {
        try {
          const linkPath = path.join(anchorDir, s.name)
          // 只处理已是链接的条目（避免覆盖 pnpm 真实目录）
          if (!fs.lstatSync(linkPath).isSymbolicLink()) continue
          const current = fs.readlinkSync(linkPath)
          if (current === s.target) continue
          fs.rmSync(linkPath, { force: true })
          fs.symlinkSync(s.target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
        } catch {
          /* noop */
        }
      }
    } catch {
      /* noop */
    }
  }

  /** 在内核目录中定位官方包路径：顶级 node_modules → .pnpm store 布局 → .pnpm 扁平
   *  （store 布局优先于扁平：host 组合（dsh-base/web-app bundle）从 pnpm store 路径解析，
   *   第一锚点指向扁平会与 host 双实例 → typert codec 校验失败，v0.8.3 实测） */
  private resolveKernelPackagePath(kernelDir: string, pkg: string): string | null {
    const candidates = [
      path.join(kernelDir, 'node_modules', '@deepseek-ai', pkg)
    ]
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c
      } catch {
        /* noop */
      }
    }
    // store 布局：.pnpm/@deepseek-ai+<pkg>@<version>_<hash>/node_modules/@deepseek-ai/<pkg>
    try {
      const storeRoot = path.join(kernelDir, 'node_modules', '.pnpm')
      const matches = fs.readdirSync(storeRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('@deepseek-ai+' + pkg + '@'))
      for (const m of matches) {
        const p = path.join(storeRoot, m.name, 'node_modules', '@deepseek-ai', pkg)
        if (fs.existsSync(p)) return p
      }
    } catch {
      /* noop */
    }
    // 扁平：.pnpm/node_modules/@deepseek-ai/<pkg>
    const flat = path.join(kernelDir, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', pkg)
    try {
      if (fs.existsSync(flat)) return flat
    } catch {
      /* noop */
    }
    return null
  }

  /** 读取内核启动健康状态（未记录 → untested） */
  bootHealthOf(version: string): KernelBootHealth {
    return this.index.kernels[version]?.bootHealth ?? 'untested'
  }

  /** npm registry 可用版本列表 */
  async listAvailable(): Promise<KernelRemoteVersion[]> {
    try {
      // R-12: 网络黑洞时 15s 超时，避免面板永久转圈
      const res = await fetch(REGISTRY_URL, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) throw new Error('registry ' + res.status)
      const data = (await res.json()) as {
        versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>
        time?: Record<string, string>
      }
      const out: KernelRemoteVersion[] = []
      for (const [v] of Object.entries(data.versions ?? {})) {
        out.push({ version: v, publishedAt: data.time?.[v] ?? null })
      }
      return out.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
    } catch (err) {
      logger.warn('kernel registry fetch failed', err)
      return []
    }
  }

  private emitProgress(p: KernelProgress): void {
    this.emit('progress', p)
    logger.info(`kernel ${p.stage}`, { version: p.version, percent: p.percent })
  }

  private async resolveNode(): Promise<string | null> {
    if (this.nodeExe && fs.existsSync(this.nodeExe)) return this.nodeExe
    // 1) 内置 Node 运行时（阶段 B：真零门槛）
    const embedded = runtimeManager.getNodeExe()
    if (embedded) {
      this.nodeExe = embedded
      return embedded
    }
    // 2) 显式指定 / 系统 node
    if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) {
      this.nodeExe = process.env.DSH_NODE
      return this.nodeExe
    }
    // R-13: 异步 where（原 execFileSync 最坏阻塞主进程 8s）
    const out = await this.execFileAsync('where', ['node'])
    const p = out?.trim().split(/\r?\n/)[0]
    if (p && fs.existsSync(p)) {
      this.nodeExe = p
      return p
    }
    return null
  }

  private findNpmCli(nodeExe: string): string | null {
    const c = path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return fs.existsSync(c) ? c : null
  }

  private async findCommand(cmd: string): Promise<string | null> {
    // 常见位置优先（npm 全局标准布局）
    const candidates: string[] = []
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'pnpm.cmd'))
    // R-13: 异步 where
    const out = await this.execFileAsync('where', [cmd])
    if (out) candidates.push(...out.trim().split(/\r?\n/))
    for (const c of candidates) {
      if (!c) continue
      try {
        if (fs.existsSync(c) && fs.statSync(c).size > 0) return c
      } catch {
        /* noop */
      }
    }
    return null
  }

  /** R-13: 异步执行命令取 stdout（避免 execFileSync 阻塞主进程） */
  private execFileAsync(cmd: string, args: string[], timeoutMs = 8_000): Promise<string | null> {
    return new Promise((resolvePromise) => {
      execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout) => {
        if (err) resolvePromise(null)
        else resolvePromise(stdout)
      })
    })
  }

  /**
   * 依赖安装器：优先 node 直接运行 JS 入口（避免 .cmd/.bat 的 cmd.exe 引号问题）：
   * 1) Node 内置 corepack pnpm → 2) 系统 pnpm 的 pnpm.cjs → 3) npm-cli.js
   */
  /**
   * 依赖安装器：优先 node 直接运行 JS 入口（避免 .cmd/.bat 的 cmd.exe 引号问题）：
   * 1) Node 内置 corepack pnpm → 2) 系统 pnpm 的 pnpm.cjs → 3) npm-cli.js
   * 缓存/存储定向到内核仓库（#3：pnpm store 内容寻址跨版本复用，不污染 %LOCALAPPDATA%\pnpm）
   */
  private async installCommand(registry: string): Promise<{ command: string; args: string[] } | null> {
    const nodeExe = this.nodeExe
    if (!nodeExe) return null

    const storeDir = path.join(this.kernelsDir, '.pnpm-store')
    const npmCacheDir = path.join(this.kernelsDir, '.npm-cache')
    fs.mkdirSync(storeDir, { recursive: true })
    fs.mkdirSync(npmCacheDir, { recursive: true })

    const corepackPnpm = path.join(path.dirname(nodeExe), 'node_modules', 'corepack', 'dist', 'pnpm.js')
    if (fs.existsSync(corepackPnpm)) {
      return { command: nodeExe, args: [corepackPnpm, 'install', '--prod', '--registry', registry, '--store-dir', storeDir] }
    }
    const pnpmCmd = (await this.findCommand('pnpm.cmd')) ?? (await this.findCommand('pnpm'))
    if (pnpmCmd) {
      const entry = path.join(path.dirname(pnpmCmd), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
      if (fs.existsSync(entry)) {
        return { command: nodeExe, args: [entry, 'install', '--prod', '--registry', registry, '--store-dir', storeDir] }
      }
    }
    const npmCli = this.findNpmCli(nodeExe)
    if (npmCli) {
      return { command: nodeExe, args: [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--cache', npmCacheDir, '--registry', registry] }
    }
    return { command: 'npm.cmd', args: ['install', '--omit=dev', '--no-audit', '--no-fund', '--cache', npmCacheDir, '--registry', registry] }
  }

  /** H4: 执行子命令；超时自动终止进程树（默认 10 分钟，内核依赖树较大） */
  private run(
    command: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
    timeoutMs = 600_000
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
      // .cmd/.bat 无法直接 spawn（Windows EINVAL）→ 经 cmd.exe 执行
      const isBatch = /\.(cmd|bat)$/i.test(command)
      const spawnCmd = isBatch ? 'cmd.exe' : command
      const spawnArgs = isBatch
        ? ['/d', '/s', '/c', `"${command}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`]
        : args
      const child = spawn(spawnCmd, spawnArgs, {
        cwd: opts.cwd,
        env: opts.env ?? { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()))
      child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
      const timer = setTimeout(() => {
        timedOut = true
        logger.warn('kernel command timeout, killing process tree', { command, timeoutMs })
        this.killTree(child.pid ?? 0)
        if (!settled) {
          settled = true
          resolvePromise({ code: -1, stdout, stderr: '命令超时（>' + timeoutMs / 1000 + 's），已终止' })
        }
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        if (timedOut) resolvePromise({ code: -1, stdout, stderr: '命令超时（>' + timeoutMs / 1000 + 's），已终止' })
        else resolvePromise({ code, stdout, stderr })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        resolvePromise({ code: -1, stdout: '', stderr: err.message })
      })
    })
  }

  /** H4: 强制结束进程树（Windows taskkill /T /F；其他平台直接 kill） */
  private killTree(pid: number): void {
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* noop */ })
      } else {
        try { process.kill(-pid, 'SIGKILL') } catch { process.kill(pid, 'SIGKILL') }
      }
    } catch {
      /* noop */
    }
  }

  /** 安装指定版本内核；registryOverride 可指定镜像源（如 npmmirror）提升国内下载速度 */
  async install(versionRaw: string, registryOverride?: string): Promise<{ ok: boolean; error?: string }> {
    const version = versionRaw.trim()
    if (!KernelManager.isValidVersion(version)) {
      return { ok: false, error: '版本号格式不合法' }
    }
    this.init()
    if (this.index.kernels[version]?.status === 'installed') {
      return { ok: false, error: `内核 v${version} 已安装` }
    }
    // broken 残留（安装中断 / 卸载中断留下的半个目录）：先清干净再装，
    // 否则 pnpm 会在残留 node_modules 上叠加，把损坏状态带进新安装
    if (this.index.kernels[version]?.status === 'broken') {
      // H4: 并发防护先于落盘动作——正在安装中就不碰目录，避免与进行中的安装相撞
      if (this.busyVersions.has(version)) {
        return { ok: false, error: '内核 v' + version + ' 正在安装中，请稍候' }
      }
      const stale = path.join(this.kernelsDir, KernelManager.safeDirName(version))
      try {
        if (fs.existsSync(stale)) {
          // 用 trashPathFor 而非拼固定后缀：上一次卸载的回收站可能还占着同名目录，
          // 而 Windows 上 rename 到已存在目录会直接失败（EPERM）
          const trash = this.trashPathFor(stale)
          fs.renameSync(stale, trash)
          this.purgeDirAsync(trash)
        }
      } catch (err) {
        // 残留目录被占用到连改名都不行：不能硬删（会删一半），直接报错让用户先停服务
        const code = (err as NodeJS.ErrnoException).code
        logger.warn('kernel install: cannot clear broken leftover', { version, code })
        return { ok: false, error: this.explainDeleteError(code, version) }
      }
      delete this.index.kernels[version]
      this.persistIndex()
    }
    // 磁盘空间 + 配额检查（阶段 C）
    const spaceErr = this.checkDiskSpace()
    if (spaceErr) return { ok: false, error: spaceErr }
    const nodeExe = await this.resolveNode()
    if (!nodeExe) {
      return { ok: false, error: '未找到可用的 Node.js 运行时。请安装 Node.js，或在「内核」面板一键下载内置运行时。' }
    }
    // registry 根（镜像加速时传根 URL，如 https://registry.npmmirror.com）
    const registryRoot = registryOverride ?? REGISTRY_ROOT

    const dirName = KernelManager.safeDirName(version)
    const kernelDir = path.join(this.kernelsDir, dirName)

    // H4: 并发防护——同一版本正在安装时拒绝重复触发（避免并发 npm/pnpm 写坏 node_modules）
    if (this.busyVersions.has(version)) {
      return { ok: false, error: '内核 v' + version + ' 正在安装中，请稍候' }
    }
    this.busyVersions.add(version)

    fs.mkdirSync(kernelDir, { recursive: true })
    const meta: KernelMeta = {
      version,
      dir: kernelDir,
      status: 'downloading',
      installedAt: null,
      size: 0,
      integrity: null,
      error: null,
      bootHealth: 'untested',
      failReason: null,
      compatPatch: null
    }
    this.index.kernels[version] = meta
    this.persistIndex()

    try {
      // 1) registry 元数据（确认版本存在）
      this.emitProgress({ version, stage: 'downloading', percent: 4, message: '获取版本元数据…' })
      // R-12: 网络黑洞时 15s 超时，避免安装永久悬挂
      const regRes = await fetch(registryRoot + '/@deepseek-ai/dsh', { signal: AbortSignal.timeout(15_000) })
      if (!regRes.ok) throw new Error('registry 元数据获取失败（HTTP ' + regRes.status + '）')
      const reg = (await regRes.json()) as {
        versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>
      }
      const dist = reg.versions?.[version]?.dist
      if (!dist?.tarball || !dist.integrity) {
        throw new Error(`版本 v${version} 在 registry 中不存在`)
      }
      meta.integrity = dist.integrity
      this.emitProgress({ version, stage: 'installing', percent: 12, message: '准备依赖清单…' })

      // 2) 标准依赖安装：kernelDir/package.json 声明依赖 → npm install（registry 校验完整性，含原生模块 prebuild）
      fs.writeFileSync(
        path.join(kernelDir, 'package.json'),
        JSON.stringify({ name: 'dsh-kernel', private: true, version: '1.0.0', dependencies: { [PACKAGE]: version } }, null, 2),
        'utf-8'
      )
      meta.status = 'installing'
      this.persistIndex()

      const installer = await this.installCommand(registryRoot)
      if (!installer) throw new Error('未找到可用的包管理器（pnpm/npm）')
      let r = await this.run(installer.command, installer.args, { cwd: kernelDir })
      // pnpm 10+ 默认忽略依赖 build scripts，并以 exit 1 + ERR_PNPM_IGNORED_BUILDS 提示——
      // 原生模块（node-pty/koffi/sharp）由平台包 prebuilt 提供，build script 仅为 fallback，忽略不等于失败
      if (r.code !== 0 && !isIgnoredBuilds(r)) {
        // 网络瞬断等偶发失败：自动重试一次（同参数）
        logger.warn('kernel deps install failed, retrying once', { version, code: r.code })
        this.emitProgress({ version, stage: 'installing', percent: 40, message: '依赖安装失败，自动重试…' })
        r = await this.run(installer.command, installer.args, { cwd: kernelDir })
        if (r.code !== 0 && !isIgnoredBuilds(r)) {
          throw new Error('依赖安装失败（exit ' + r.code + '）：' + (r.stderr || r.stdout).slice(0, 800))
        }
      }
      this.emitProgress({ version, stage: 'installing', percent: 90, message: '自检内核…' })

      // 3) 自检
      const binJs = this.binJsFor(version)
      if (!binJs) throw new Error('内核安装后未找到 bin.js')
      const chk = await this.run(nodeExe, [binJs, '--version'])
      if (chk.code !== 0 || !chk.stdout.trim()) {
        throw new Error(`内核自检失败：${(chk.stderr || chk.stdout).slice(0, 300)}`)
      }

      meta.status = 'installed'
      meta.installedAt = Date.now()
      meta.size = await dirSizeAsync(kernelDir)
      meta.error = null
      this.persistIndex()
      // 新内核就绪即重建第一锚点官方包链接（指向本内核），后续切换默认/绑定档案时不再版本混杂
      this.relinkProfileAnchor(version)
      this.emitProgress({ version, stage: 'done', percent: 100, message: `内核 v${version} 安装完成（${chk.stdout.trim()}）` })
      logger.info('kernel installed', { version, size: meta.size })
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      meta.status = 'error'
      meta.error = msg
      // H4: 清理失败残留，避免下次安装在新目录上叠加损坏的 node_modules
      try {
        if (fs.existsSync(kernelDir)) fs.rmSync(kernelDir, { recursive: true, force: true })
      } catch {
        /* noop */
      }
      this.persistIndex()
      this.emitProgress({ version, stage: 'error', percent: 0, message: msg })
      logger.error('kernel install failed', { version, error: msg })
      return { ok: false, error: msg }
    } finally {
      this.busyVersions.delete(version)
    }
  }

  /**
   * 卸载内核。
   *
   * 关键设计：**改名优先、删除兜底**。
   * 背景（实测于 Windows）：内核的 sharp / node-pty / koffi 等原生模块在多个内核版本之间
   * 是 pnpm 硬链接共享的**同一个文件对象**；当某个版本正在运行时，其 DLL 被进程映射，
   * 此时删除另一个版本里指向同一文件对象的硬链接会被系统拒绝（EPERM/EBUSY）。
   * 裸用 fs.rmSync(target, {recursive,force}) 遇到第一个这样的文件就抛异常中断，
   * 且不重试不回滚 → 目录被删掉一半、连 bin.js 都没了（内核实际已损坏），
   * 而索引项仍留在 kernels.json 里显示「已安装」，用户只能反复点卸载、每次再破坏一次。
   *
   * 实测：目标目录里有被映射的 DLL 时，**rename 父目录仍然可用**（只有删文件被拒）。
   * 因此这里先把目录 rename 成 `<version>.deleting`（瞬时、不遍历子项、不会被锁阻），
   * 立刻清掉索引项并把该版本还给用户（旧目录已被移出 kernels/<version>，
   * binJsFor 立刻失效 → 不再可能被当作可用内核启动），再去后台尽力删除。
   * 后台删不掉也没有关系：它已经不在内核仓库任何有效位置上，留给下次启动回收。
   *
   * @param opts.skipRefCheck 跳过「默认内核 / 档案绑定」引用保护（供清理已损坏内核使用）
   *
   * 注意：故意保持**同步**签名（无 await）——卸载的核心动作（rename + 清索引）本来就是瞬时的，
   * 真正耗时的物理删除已转交 purgeDirAsync。IPC 层用 ipcRenderer.invoke 天然返回 Promise，
   * 而测试与其他调用点依赖同步拿到 SaveResult，不必要地改成 async 会破坏该契约。
   */
  uninstall(version: string, opts: { skipRefCheck?: boolean } = {}): SaveResult {
    this.init()
    const meta = this.index.kernels[version]
    if (!meta) return { ok: false, error: '内核 v' + version + ' 未安装' }
    const cfg = configStore.get()
    // 引用保护。broken 项是例外：它不是「能用的内核」，留着只会占盘；面板也不允许把它
    // 设为默认/绑定档案，所以不存在「正在被使用」的语义，但仍挡一道默认内核才安全。
    if (!opts.skipRefCheck && cfg.kernelMode === 'managed' && cfg.defaultKernelVersion === version) {
      return { ok: false, error: 'v' + version + ' 是当前默认内核，请先切换默认版本后再卸载' }
    }
    const refProfiles = opts.skipRefCheck
      ? []
      : (cfg.profiles ?? []).filter((p) => p.kernelVersion === version)
    if (refProfiles.length > 0) {
      return {
        ok: false,
        error: 'v' + version + ' 被配置档案「' + refProfiles.map((p) => p.name).join('、') + '」绑定，请先解除绑定'
      }
    }
    const target = path.join(this.kernelsDir, KernelManager.safeDirName(version))
    if (!target.startsWith(this.kernelsDir)) return { ok: false, error: '非法路径' }

    // ① 先把目录移出有效位置（改名），成功即视为卸载生效
    const trash = this.trashPathFor(target)
    let moved = false
    if (fs.existsSync(target)) {
      try {
        fs.renameSync(target, trash)
        moved = true
      } catch (err) {
        // 改名也失败（极少见）：目录被占用到连改名都不行，此时**绝不**删索引、
        // 也绝不尝试 rmSync——否则就是旧的「删一半」惨案。如实报错并保留可重试状态。
        const code = (err as NodeJS.ErrnoException).code
        logger.warn('kernel uninstall: rename to trash failed', { version, code })
        return { ok: false, error: this.explainDeleteError(code, version) }
      }
    }

    // ② 索引项立即清掉（卸载已生效，不再当作已安装内核）
    delete this.index.kernels[version]
    this.persistIndex()
    this.trashSizeCache = null
    logger.info('kernel uninstalled', { version, movedToTrash: moved })

    // ③ 后台尽力删除回收站（不阻塞 IPC）；删不掉留待下次启动回收
    if (moved) this.purgeDirAsync(trash)
    return { ok: true }
  }

  /**
   * 回收站路径。**必须保证不与已存在的目录撞名**：
   * Windows 上 rename 到一个已存在的目录会直接失败（EPERM），而不是覆盖，
   * 因此不能简单地固定用 `<version>.deleting`——上一次卸载删不掉时它就还在那里，
   * 下一次卸载会因为这个残留而改名失败、永远卸不掉。
   * 撞名则追加时间戳，保证改名一定成功。
   */
  private trashPathFor(target: string): string {
    const base = target + TRASH_SUFFIX
    if (!fs.existsSync(base)) return base
    return base + '-' + Date.now().toString(36)
  }

  /**
   * 后台删除回收站目录，失败不抛错（留给启动回收）。
   * maxRetries/retryDelay：被占用通常是**瞬时**的（DSH 进程正在退出/句柄正在释放），
   * Windows 上等几百毫秒往往就能删掉，故给几轮退避重试。
   */
  private purgeDirAsync(dir: string): void {
    if (this.purging.has(dir)) return
    this.purging.add(dir)
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }, (err) => {
      this.purging.delete(dir)
      this.trashSizeCache = null
      if (err) {
        const code = (err as NodeJS.ErrnoException).code
        // 删不掉不是错误：目录已不在任何有效内核路径上，下次启动/下次卸载会再试
        logger.warn('kernel trash purge deferred (will retry on next startup)', { dir, code })
        return
      }
      // 回收站空了就顺手删掉父目录里已不存在的索引残留（无操作，仅日志）
      logger.info('kernel trash purged', { dir })
    })
  }

  /**
   * 把所有回收站（名字含 `.deleting`，含带时间戳后缀的）再尝试删一次（启动时调用）。
   * 启动场景下上一个进程的临时占用通常已经释放，因此这一轮往往能真正回收磁盘。
   */
  purgeTrash(): void {
    this.init()
    let names: string[] = []
    try {
      names = fs.readdirSync(this.kernelsDir).filter((n) => n.includes(TRASH_SUFFIX))
    } catch {
      return
    }
    if (names.length === 0) return
    logger.info('kernel trash found on startup, purging', { count: names.length })
    for (const n of names) this.purgeDirAsync(path.join(this.kernelsDir, n))
  }

  /**
   * 启动对账：修正 kernels.json 与实际磁盘的不一致。
   * 处理三类历史遗留（均由「裸 rmSync 删除中断 / 安装中断」产生）：
   * ① installed 但 bin.js 缺失 → 标 broken（内核不可用，但磁盘仍占用，面板可卸载）
   * ② downloading/verifying/installing 但目录还在 → 安装残留，标 broken 供卸载
   *    （这类项 listInstalled 不返回，界面上完全看不见却占着数百 MB，会一直泄漏）
   * ③ 索引有项但目录已不存在 → 直接清掉索引项
   * 对 broken 项重测实际占用写回 size，保证配额统计贴合磁盘真实情况。
   * 返回变更摘要供日志与测试断言。
   */
  reconcile(): { broken: string[]; orphaned: string[] } {
    this.init()
    const broken: string[] = []
    const orphaned: string[] = []
    /** broken 项待后台重测占用的版本（启动不应被大目录扫描阻塞） */
    const needsResize: string[] = []
    let changed = false
    for (const [version, meta] of Object.entries(this.index.kernels)) {
      const dir = path.join(this.kernelsDir, KernelManager.safeDirName(version))
      if (!fs.existsSync(dir)) {
        // ③ 目录已不在（历史上删除成功但索引未清干净，或用户手动删了目录）
        delete this.index.kernels[version]
        orphaned.push(version)
        changed = true
        continue
      }
      const hasBin = this.binJsFor(version) !== null
      if (meta.status === 'installed' && !hasBin) {
        // ① 半个内核：不完整、绝不能被启动，但占盘 → 标 broken
        meta.status = 'broken'
        meta.error = meta.error ?? '内核文件不完整（bin.js 缺失），可能由上一次卸载中断导致'
        broken.push(version)
        changed = true
      } else if (meta.status !== 'installed' && meta.status !== 'broken') {
        // ② 安装/下载中断残留，以及目录仍旧存在但安装已失败的 error 项：
        // 它们界面上都看不见（listInstalled 只认 installed/broken）却占着盘，会一直泄漏
        meta.status = 'broken'
        meta.error = meta.error ?? '安装被中断，内核文件不完整'
        broken.push(version)
        changed = true
      }
      if (meta.status === 'broken') {
        // broken 项的 size 通常失真（索引记的是安装时的值，实际已被删掉一部分）→ 需重测。
        // 但**不在启动同步路径上测**：实测单目录（150MB/1.7 万文件）同步扫描要 3.6s，
        // 两个 broken 项就是 ~7s 主进程冻结（启动卡死）。改为后台异步测量，见 remeasureBrokenAsync。
        needsResize.push(version)
      }
    }
    if (changed) this.persistIndex()
    // 后台异步重测 broken 项占用（不阻塞启动；完成后自行落盘）
    if (needsResize.length > 0) void this.remeasureBrokenAsync(needsResize)
    // 默认内核自身损坏：getActiveVersion 会因 status != installed 而静默回退系统 dsh，
    // 但 config 里仍指着它，面板会显示「当前默认」且卸载被引用保护拦住 = 死锁。
    // 这里把默认指针清掉（与运行时的实际行为对齐），用户可重新选一个可用内核。
    const cfg = configStore.get()
    if (cfg.defaultKernelVersion && this.index.kernels[cfg.defaultKernelVersion]?.status === 'broken') {
      logger.warn('default kernel is broken, clearing default pointer', { version: cfg.defaultKernelVersion })
      configStore.set({ defaultKernelVersion: null })
    }
    // 回滚指针（previousKernelVersion = 崩溃自动回滚目标）指向已不可用的内核 → 清掉悬空值。
    // 回滚前会校验 listUsable 并跳过，所以不会引发故障，但配置里留着一个已卸载的版本号，
    // 会让「回滚」这张安全网事实上失效却看不出来（用户以为有兼底，实际没有）。
    // get() 返回的是快照，故在上一次 set 之后重新读取。
    const afterDefault = configStore.get()
    if (
      afterDefault.previousKernelVersion &&
      !this.listUsable().some((k) => k.version === afterDefault.previousKernelVersion)
    ) {
      logger.warn('previous kernel no longer usable, clearing rollback pointer', {
        version: afterDefault.previousKernelVersion
      })
      configStore.set({ previousKernelVersion: null })
    }
    if (broken.length || orphaned.length) {
      logger.warn('kernel reconcile found inconsistencies', { broken, orphaned })
    }
    return { broken, orphaned }
  }

  /**
   * 后台重测 broken 项的磁盘占用并写回索引（异步，不阻塞启动）。
   * 目的：配额/面板显示贴磁盘真实值（卸载中断后索引里的旧 size 会明显偏大），
   * 但数百 MB ÷ 上万文件的同步扫描会冻结主进程，因此只能放到后台慢慢做。
   */
  private async remeasureBrokenAsync(versions: string[]): Promise<void> {
    let changed = false
    for (const version of versions) {
      const meta = this.index.kernels[version]
      if (!meta || meta.status !== 'broken') continue
      const dir = path.join(this.kernelsDir, KernelManager.safeDirName(version))
      if (!fs.existsSync(dir)) continue
      try {
        const actual = await dirSizeAsync(dir)
        const cur = this.index.kernels[version]
        if (cur && cur.status === 'broken' && actual !== cur.size) {
          cur.size = actual
          changed = true
          logger.info('kernel broken size remeasured', { version, size: actual })
        }
      } catch (err) {
        logger.warn('kernel broken size remeasure failed', { version, err: String(err) })
      }
    }
    if (changed) this.persistIndex()
  }

  /** 删除类系统错误 → 面向用户的中文说明（Windows 上 EPERM/EBUSY 含义容易被误解为权限问题） */
  private explainDeleteError(code: string | undefined, version: string): string {
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      return (
        '内核 v' + version + ' 的文件正被占用，无法删除（通常是 DSH 服务正在运行，' +
        '其原生模块 sharp/koffi 被进程加载后 Windows 会拒绝删除）。' +
        '请先停止服务后重试。'
      )
    }
    if (code === 'ENOTEMPTY') {
      return '内核 v' + version + ' 目录非空，可能有文件仍被占用，请稍后重试。'
    }
    return '卸载 v' + version + ' 失败' + (code ? '（' + code + '）' : '')
  }

  /** 内核仓库总占用（字节） */
  /**
   * 内核仓库总占用（字节）。
   * 取值口径：已安装内核用安装时的实测快照；broken 项的 size 已在启动对账
   * （reconcile）里按磁盘实际残留重测写回——因为索引里的旧值会与实际严重不符
   * （实测：某内核索引记 223MB，删掉一半后实际只剩 179MB）。
   * 不在这里做全量扫描：4 份内核 × 250MB 每次开面板都扫一遍会让 UI 卡顿，
   * 全量重测统一放到启动对账一次性完成。
   */
  totalSizeBytes(): number {
    return Object.values(this.index.kernels)
      .filter((k) => k.status === 'installed' || k.status === 'broken')
      .reduce((sum, k) => sum + (k.size || 0), 0)
  }

  /**
   * 待回收（.deleting）目录总占用（字节）。
   * **永不在同步路径上扫描**：回收站可能是整个内核（数百 MB / 上万文件），
   * 同步扫会把主进程冻结数秒（实测 150MB → 3.6s）。这里只回缓存值，
   * 缓存过期时触发一次后台测量，下一次读取（面板轮询/重新打开）即为实测值。
   */
  trashSizeBytes(): number {
    this.init()
    const now = Date.now()
    if (!this.trashSizeCache || now - this.trashSizeCache.at >= 30_000) {
      this.scheduleTrashMeasure()
    }
    return this.trashSizeCache ? this.trashSizeCache.mb * 1024 * 1024 : 0
  }

  /** 后台测量回收站占用（带去重，避免面板反复拉取时并发狂扫） */
  private scheduleTrashMeasure(): void {
    if (this.trashMeasuring) return
    this.trashMeasuring = true
    void (async () => {
      try {
        let bytes = 0
        for (const n of fs.readdirSync(this.kernelsDir)) {
          if (!n.includes(TRASH_SUFFIX)) continue
          bytes += await dirSizeAsync(path.join(this.kernelsDir, n))
        }
        this.trashSizeCache = { at: Date.now(), mb: Math.round(bytes / (1024 * 1024)) }
      } catch {
        // 测量失败不抛错：下次读取再试（缓存留空会再触发）
        this.trashSizeCache = { at: Date.now(), mb: 0 }
      } finally {
        this.trashMeasuring = false
      }
    })()
  }

  /** 存储统计（配额，阶段 C） */
  quota(): KernelQuota {
    this.init()
    const cfg = configStore.get()
    let runtimeMB = 0
    try {
      const r = runtimeManager.getRuntimeDir()
      if (fs.existsSync(r)) {
        // R-15: 缓存 30s，避免每次打开面板全量同步扫描数百 MB 的 runtimes/
        const now = Date.now()
        if (this.runtimeSizeCache === null || now - this.runtimeSizeCache.at > 30_000) {
          this.runtimeSizeCache = { at: now, mb: Math.round(dirSizeSync(r) / (1024 * 1024)) }
        }
        runtimeMB = this.runtimeSizeCache.mb
      }
    } catch {
      /* noop */
    }
    return {
      quotaMB: cfg.kernelsQuotaMB ?? 1024,
      usedMB: Math.round(this.totalSizeBytes() / (1024 * 1024)),
      runtimeMB,
      diskFreeMB: runtimeManager.diskFreeMB(),
      // 待回收占用单独报出：用户看到「已卸载但磁盘没降」时，这里给出解释
      pendingRemovalMB: Math.round(this.trashSizeBytes() / (1024 * 1024))
    }
  }

  /** 安装前磁盘/配额检查；通过返回 null，否则返回错误信息 */
  private checkDiskSpace(): string | null {
    const cfg = configStore.get()
    // 磁盘剩余空间（需要至少 500MB，含依赖下载与解压余量）
    const free = runtimeManager.diskFreeMB()
    if (free >= 0 && free < 500) return '磁盘剩余空间不足（' + free + 'MB < 500MB）'
    // 内核仓库配额（0 = 不限制）
    const quotaMB = cfg.kernelsQuotaMB ?? 1024
    if (quotaMB > 0) {
      const usedMB = Math.round(this.totalSizeBytes() / (1024 * 1024))
      const ESTIMATE_MB = 60 // 单内核依赖树估算（~50MB+，留余量）
      if (usedMB + ESTIMATE_MB > quotaMB) {
        return '内核仓库已超配额（' + usedMB + 'MB + 预估 ' + ESTIMATE_MB + 'MB > 配额 ' + quotaMB + 'MB），请先卸载部分版本或调高配额'
      }
    }
    return null
  }

  /**
   * 内核更新检测（阶段 B）
   * 口径：只认 rc（正式发布通道）版本，alpha/next 预览版不推（与「安装新版本」的「推荐」一致）。
   * 不能只看 dist-tags.latest：@deepseek-ai/dsh 的 latest 会长期停在旧版（如 0.1.1-rc.2），
   * 新版走 rc/next 通道发布；取所有通道里版本最大的 rc 作为「可升级最新版」。
   */
  async checkUpdate(): Promise<KernelUpdateInfo> {
    const cfg = configStore.get()
    const current = cfg.kernelMode === 'managed' ? cfg.defaultKernelVersion : null
    const info: KernelUpdateInfo = {
      current,
      latest: null,
      latestTag: null,
      rc: null,
      available: false,
      url: 'https://www.npmjs.com/package/@deepseek-ai/dsh',
      checkedAt: Date.now(),
      error: null
    }
    try {
      const res = await fetch(REGISTRY_URL, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) throw new Error('registry ' + res.status)
      const data = (await res.json()) as { 'dist-tags'?: Record<string, string> }
      const tags = data['dist-tags'] ?? {}
      // 同版本被多个 tag 指向时（如 latest 与 next 都指 0.1.2-rc.1），按 tag 语义取更“正式”的那个
      const tagPriority = (t: string): number => (t === 'latest' ? 0 : t === 'rc' ? 1 : t === 'next' ? 2 : 3)
      let latest: string | null = null
      let latestTag: string | null = null
      for (const [tag, ver] of Object.entries(tags)) {
        if (typeof ver !== 'string' || !isRcVersion(ver)) continue
        if (latest === null) {
          latest = ver
          latestTag = tag
          continue
        }
        const cmp = compareVersions(ver, latest)
        if (cmp > 0 || (cmp === 0 && latestTag !== null && tagPriority(tag) < tagPriority(latestTag))) {
          latest = ver
          latestTag = tag
        }
      }
      info.latest = latest
      info.latestTag = latestTag
      info.rc = typeof tags['rc'] === 'string' ? tags['rc'] : null
      info.available = !!latest && !!current && compareVersions(latest, current) > 0
      return info
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err)
      logger.warn('kernel update check failed', err)
      return info
    }
  }
}

function dirSizeSync(dir: string): number {
  let s = 0
  try {
    const stack = [dir]
    while (stack.length) {
      const cur = stack.pop()
      if (!cur) continue
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, e.name)
        if (e.isDirectory()) stack.push(p)
        else s += fs.statSync(p).size
      }
    }
  } catch {
    /* noop */
  }
  return s
}

/**
 * 异步目录大小（不阻塞主进程）。
 * 为何需要异步版：实测 150MB / 1.7 万文件的目录**同步**扫描耗时 3.6s，
 * 放在启动对账或面板轮询里会把主进程冻结数秒（窗口/托盘全部无响应）。
 * 策略：同一目录内用 Promise.all 批量 stat，跨目录用栈串行 —— 既不会开启过多句柄，
 * 也不占用事件循环（每个 await 都让出）。
 */
async function dirSizeAsync(dir: string): Promise<number> {
  let s = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur) continue
    let ents: fs.Dirent[]
    try {
      ents = await fs.promises.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    const sizes = await Promise.all(
      ents.map(async (e) => {
        const p = path.join(cur, e.name)
        if (e.isDirectory()) {
          stack.push(p)
          return 0
        }
        try {
          return (await fs.promises.stat(p)).size
        } catch {
          return 0
        }
      })
    )
    for (const n of sizes) s += n
  }
  return s
}


/** pnpm10 忽略 build scripts 提示（exit 1 但依赖已安装成功） */
function isIgnoredBuilds(r: { code: number | null; stdout: string; stderr: string }): boolean {
  return /ERR_PNPM_IGNORED_BUILDS|IGNORED_BUILDS/i.test(r.stderr + ' ' + r.stdout)
}

export const kernelManager = new KernelManager()
