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
import { spawn, execFileSync } from 'node:child_process'
import { logger } from './logger'
import type { KernelInfo, KernelProgress, KernelRemoteVersion } from '../shared/types'

const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'
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
      fs.writeFileSync(this.indexFile(), JSON.stringify(this.index, null, 2), 'utf-8')
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
      const res = await fetch(REGISTRY_URL, { headers: { Accept: 'application/vnd.npm.install-v1+json' } })
      if (!res.ok) throw new Error(`registry ${res.status}`)
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

  private resolveNode(): string | null {
    if (this.nodeExe && fs.existsSync(this.nodeExe)) return this.nodeExe
    if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) {
      this.nodeExe = process.env.DSH_NODE
      return this.nodeExe
    }
    try {
      const out = execFileSyncSafe('where', ['node'])
      const p = out?.trim().split(/\r?\n/)[0]
      if (p && fs.existsSync(p)) {
        this.nodeExe = p
        return p
      }
    } catch {
      /* noop */
    }
    return null
  }

  private findNpmCli(nodeExe: string): string | null {
    const c = path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return fs.existsSync(c) ? c : null
  }

  private findCommand(cmd: string): string | null {
    // 常见位置优先（npm 全局标准布局）
    const candidates: string[] = []
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'pnpm.cmd'))
    try {
      const out = execFileSync('where', [cmd], { windowsHide: true, timeout: 8_000, encoding: 'utf-8' })
      candidates.push(...out.trim().split(/\r?\n/))
    } catch {
      /* noop */
    }
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

  /**
   * 依赖安装器：优先 node 直接运行 JS 入口（避免 .cmd/.bat 的 cmd.exe 引号问题）：
   * 1) Node 内置 corepack pnpm → 2) 系统 pnpm 的 pnpm.cjs → 3) npm-cli.js
   */
  private installCommand(registry: string): { command: string; args: string[] } | null {
    const nodeExe = this.nodeExe
    if (!nodeExe) return null

    const corepackPnpm = path.join(path.dirname(nodeExe), 'node_modules', 'corepack', 'dist', 'pnpm.js')
    if (fs.existsSync(corepackPnpm)) {
      return { command: nodeExe, args: [corepackPnpm, 'install', '--prod', '--registry', registry] }
    }
    const pnpmCmd = this.findCommand('pnpm.cmd') ?? this.findCommand('pnpm')
    if (pnpmCmd) {
      const entry = path.join(path.dirname(pnpmCmd), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
      if (fs.existsSync(entry)) {
        return { command: nodeExe, args: [entry, 'install', '--prod', '--registry', registry] }
      }
    }
    const npmCli = this.findNpmCli(nodeExe)
    if (npmCli) {
      return { command: nodeExe, args: [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--registry', registry] }
    }
    return { command: 'npm.cmd', args: ['install', '--omit=dev', '--no-audit', '--no-fund', '--registry', registry] }
  }

  private run(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
      child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()))
      child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
      child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
      child.on('error', (err) => resolvePromise({ code: -1, stdout: '', stderr: err.message }))
    })
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
    const nodeExe = this.resolveNode()
    if (!nodeExe) {
      return { ok: false, error: '未找到 Node.js 运行时（阶段 B 将内置运行时，当前需系统 Node）' }
    }
    const registry = registryOverride ?? REGISTRY_URL

    const dirName = KernelManager.safeDirName(version)
    const kernelDir = path.join(this.kernelsDir, dirName)

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
      const reg = (await (await fetch(registry)).json()) as {
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

      const installer = this.installCommand(registry)
      if (!installer) throw new Error('未找到可用的包管理器（pnpm/npm）')
      const r = await this.run(installer.command, installer.args, { cwd: kernelDir })
      if (r.code !== 0) {
        throw new Error(`依赖安装失败（exit ${r.code}）：${r.stderr.slice(0, 800)}`)
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
      this.persistIndex()
      this.emitProgress({ version, stage: 'error', percent: 0, message: msg })
      logger.error('kernel install failed', { version, error: msg })
      return { ok: false, error: msg }
    }
  }

  /** 卸载内核（若为默认版本则需先解除默认） */
  uninstall(version: string): { ok: boolean; error?: string } {
    this.init()
    const meta = this.index.kernels[version]
    if (!meta) return { ok: false, error: `内核 v${version} 未安装` }
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
}

function execFileSyncSafe(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { windowsHide: true, timeout: 8_000, encoding: 'utf-8' })
  } catch {
    return null
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

export const kernelManager = new KernelManager()