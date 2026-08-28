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
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { logger } from './logger'
import { configStore } from './config'
import { runtimeManager } from './runtime-manager'
import { compareVersions } from '../shared/version'
import type { KernelInfo, KernelProgress, KernelQuota, KernelRemoteVersion, KernelUpdateInfo } from '../shared/types'

const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'
/** registry 根（install --registry 参数需要根 URL，不是包元数据 URL） */
const REGISTRY_ROOT = 'https://registry.npmjs.org'
const PACKAGE = '@deepseek-ai/dsh'
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

interface KernelMeta {
  version: string
  dir: string
  status: KernelInfo['status']
  installedAt: number | null
  size: number
  integrity: string | null
  error: string | null
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
  /** R-15: 内置运行时目录大小缓存（30s TTL，避免 quota() 每次全量同步扫描） */
  private runtimeSizeCache: { at: number; mb: number } | null = null

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
        this.index = JSON.parse(fs.readFileSync(this.indexFile(), 'utf-8')) as KernelIndex
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

  listInstalled(): KernelInfo[] {
    return Object.values(this.index.kernels)
      .filter((k) => k.status === 'installed')
      .map((k) => this.toInfo(k))
      .sort((a, b) => (b.installedAt ?? 0) - (a.installedAt ?? 0))
  }

  private toInfo(k: KernelMeta): KernelInfo {
    return {
      version: k.version,
      dir: k.dir,
      status: k.status,
      installedAt: k.installedAt,
      size: k.size,
      integrity: k.integrity,
      error: k.error
    }
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
      child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()))
      child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
      const timer = setTimeout(() => {
        timedOut = true
        logger.warn('kernel command timeout, killing process tree', { command, timeoutMs })
        this.killTree(child.pid ?? 0)
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        if (timedOut) resolvePromise({ code: -1, stdout, stderr: '命令超时（>' + timeoutMs / 1000 + 's），已终止' })
        else resolvePromise({ code, stdout, stderr })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
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
      error: null
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
      meta.size = dirSizeSync(kernelDir)
      meta.error = null
      this.persistIndex()
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

  /** 卸载内核（阶段 C：引用保护——默认版本或任一 Profile 绑定的版本不可卸载） */
  uninstall(version: string): { ok: boolean; error?: string } {
    this.init()
    const meta = this.index.kernels[version]
    if (!meta) return { ok: false, error: '内核 v' + version + ' 未安装' }
    const cfg = configStore.get()
    if (cfg.kernelMode === 'managed' && cfg.defaultKernelVersion === version) {
      return { ok: false, error: 'v' + version + ' 是当前默认内核，请先切换默认版本后再卸载' }
    }
    const refProfiles = (cfg.profiles ?? []).filter((p) => p.kernelVersion === version)
    if (refProfiles.length > 0) {
      return {
        ok: false,
        error: 'v' + version + ' 被配置档案「' + refProfiles.map((p) => p.name).join('、') + '」绑定，请先解除绑定'
      }
    }
    try {
      const target = path.join(this.kernelsDir, KernelManager.safeDirName(version))
      if (!target.startsWith(this.kernelsDir)) return { ok: false, error: '非法路径' }
      fs.rmSync(target, { recursive: true, force: true })
      delete this.index.kernels[version]
      this.persistIndex()
      logger.info('kernel uninstalled', { version })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 内核仓库总占用（字节） */
  totalSizeBytes(): number {
    return Object.values(this.index.kernels)
      .filter((k) => k.status === 'installed')
      .reduce((sum, k) => sum + (k.size || 0), 0)
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
      diskFreeMB: runtimeManager.diskFreeMB()
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

  /** 内核更新检测（阶段 B：registry dist-tags latest/rc） */
  async checkUpdate(): Promise<KernelUpdateInfo> {
    const cfg = configStore.get()
    const current = cfg.kernelMode === 'managed' ? cfg.defaultKernelVersion : null
    const info: KernelUpdateInfo = {
      current,
      latest: null,
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
      info.latest = data['dist-tags']?.latest ?? null
      info.rc = data['dist-tags']?.rc ?? null
      info.available = !!info.latest && !!current && compareVersions(info.latest, current) > 0
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


/** pnpm10 忽略 build scripts 提示（exit 1 但依赖已安装成功） */
function isIgnoredBuilds(r: { code: number | null; stdout: string; stderr: string }): boolean {
  return /ERR_PNPM_IGNORED_BUILDS|IGNORED_BUILDS/i.test(r.stderr + ' ' + r.stdout)
}

export const kernelManager = new KernelManager()