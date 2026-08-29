/**
 * DSH 进程管理（文档 §4.1.1）
 * - 启动/停止/重启 `dsh web` 子进程
 * - 使用 `--port 0` 让系统自动分配空闲端口
 * - 从 stdout 解析实际端口，定期健康检查
 * - 崩溃自动重启（退避），状态变更通知订阅者
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { logger } from './logger'
import { configStore } from './config'
import { kernelManager } from './kernel-manager'
import { runtimeManager } from './runtime-manager'
import type { DSHState } from '../shared/types'

const PORT_RE = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/i
/** 完整 Web UI 地址（alpha 内核带 ?token=…；必须先用它首次访问才能签发 cookie） */
const WEB_URL_RE = /dsh web: (https?:\/\/[^\s]+)/i
const HEALTH_PATHS = ['/health', '/api/health', '/']
const READY_TIMEOUT_MS = 60_000
const RESTART_BACKOFF_MS = 3_000
/** 崩溃重启退避上限（指数退避封顶） */
const RESTART_BACKOFF_MAX_MS = 60_000
/** 连续崩溃上限（达到后进入 error 等待人工干预，替代原失效的 >=10 判断） */
const MAX_RESTARTS = 10
/** 稳定运行超过该时长后再崩溃视为新一轮（重置崩溃计数） */
const STABLE_RESET_MS = 60_000

export class DSHManager extends EventEmitter {
  private child: ChildProcess | null = null
  private status: DSHState['status'] = 'stopped'
  private port: number | null = null
  private version: string | null = null
  private dshHome: string | null = null
  private pid: number | null = null
  private startedAt: number | null = null
  private lastError: string | null = null
  private restartCount = 0
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private stdoutBuffer = ''
  private executable: { command: string; args: string[] } | null = null
  private nodeExe: string | null = null
  /** H5: 当前进程打印的 Web UI 完整 URL（含认证 token；alpha 内核需携带 token 首次访问以签发 cookie） */
  private webUrl: string | null = null
  private healthTimer: NodeJS.Timeout | null = null
  /** H2: 进行中的 start()（并发防护：并发调用复用同一实例） */
  private startInFlight: Promise<void> | null = null
  /** H1: 最近一次进入 running 的时间（区分"稳定后崩溃"与"连续崩溃循环"） */
  private stableSince: number | null = null

  getState(): DSHState {
    return {
      status: this.status,
      port: this.port,
      webUrl: this.webUrl,
      version: this.version,
      dshHome: this.dshHome,
      pid: this.pid,
      startedAt: this.startedAt,
      lastError: this.lastError,
      restartCount: this.restartCount
    }
  }

  private setStatus(status: DSHState['status']): void {
    this.status = status
    logger.info(`dsh status -> ${status}`, { port: this.port, pid: this.pid })
    this.emit('statusChange', this.getState())
  }

  /** 返回 DSH Home 目录（遵循官方规则：DSH_HOME 环境变量优先，否则 %USERPROFILE%\.dsh） */
  resolveDshHome(): string {
    const cfg = configStore.get()
    if (cfg.dshHome) return cfg.dshHome
    if (process.env.DSH_HOME) return process.env.DSH_HOME
    return path.join(os.homedir(), '.dsh')
  }

  /** 当前进程的 Web UI 完整 URL（含认证 token；老内核为纯端口地址）。进程重启后由新 stdout 刷新 */
  getWebUrl(): string | null {
    return this.webUrl
  }

  /**
   * 解析 dsh 可执行入口，探测顺序：
   * 1. DSH_EXECUTABLE 环境变量（显式指定，兼容打包自带/自定义安装）
   * 2. npm/pnpm 全局安装的 @deepseek-ai/dsh（bin.js 由 node 直接运行）
   * 3. PATH 中的 dsh/dsh.cmd（shell 方式）
   */
  private async resolveExecutable(): Promise<{ command: string; args: string[] }> {
    if (this.executable) return this.executable

    // ① 托管内核（kernelMode=managed）—— 多内核共存路由（阶段 C：Profile 绑定优先）
    kernelManager.init()
    const cfg = configStore.get()
    const profile = (cfg.profiles ?? []).find((p) => p.id === cfg.activeProfileId)
    const kernelVersion =
      cfg.kernelMode === 'managed' ? (profile?.kernelVersion ?? cfg.defaultKernelVersion) : null
    if (kernelVersion) {
      const binJs = kernelManager.binJsFor(kernelVersion)
      if (binJs) {
        const nodeExe = await this.resolveNode()
        this.executable = { command: nodeExe, args: [binJs] }
        logger.info('dsh entry resolved via managed kernel', { version: kernelVersion, profile: profile?.id, binJs })
        return this.executable
      }
      logger.warn('managed kernel not ready, falling back to system dsh', { version: kernelVersion })
    }

    // ② 环境变量
    const explicit = process.env.DSH_EXECUTABLE
    if (explicit) {
      if (fs.existsSync(explicit)) {
        if (explicit.toLowerCase().endsWith('.js')) {
          this.executable = { command: this.nodeExe ?? (await this.resolveNode()), args: [explicit] }
        } else {
          this.executable = { command: explicit, args: [] }
        }
        logger.info('dsh executable from DSH_EXECUTABLE', { command: this.executable.command })
        return this.executable
      }
      logger.warn('DSH_EXECUTABLE set but not found', { explicit })
    }

    // ② npm 全局安装
    try {
      const prefix = await this.execCapture('npm.cmd', ['prefix', '-g'], { shell: true })
      if (prefix) {
        const binJs = path.join(prefix.trim(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if (fs.existsSync(binJs)) {
          this.executable = { command: this.nodeExe ?? (await this.resolveNode()), args: [binJs] }
          logger.info('dsh entry resolved via npm prefix', { binJs })
          return this.executable
        }
      }
    } catch (err) {
      logger.debug('npm prefix lookup failed', err)
    }

    // ③ PATH 中的 dsh.cmd：解析其内部 node_modules 路径
    try {
      const found = await this.execCapture('where', ['dsh.cmd'])
      const cmdPath = found?.trim().split(/\r?\n/)[0]
      if (cmdPath && fs.existsSync(cmdPath)) {
        const content = fs.readFileSync(cmdPath, 'utf-8')
        const m = content.match(/"%dp0%\\node_modules\\([^"]+\.js)"/)
        if (m) {
          const binJs = path.join(path.dirname(cmdPath), 'node_modules', m[1])
          if (fs.existsSync(binJs)) {
            this.executable = { command: this.nodeExe ?? (await this.resolveNode()), args: [binJs] }
            logger.info('dsh entry resolved via where dsh.cmd', { binJs })
            return this.executable
          }
        }
        // 退化为直接调用 dsh.cmd（shell 由 spawn 处理）
        this.executable = { command: cmdPath, args: [] }
        logger.info('dsh resolved to dsh.cmd', { cmdPath })
        return this.executable
      }
    } catch (err) {
      logger.debug('where dsh.cmd lookup failed', err)
    }

    // ③' ：PATH 中的 dsh（Unix 风格可执行/其他平台）
    try {
      const found = await this.execCapture('where', ['dsh'])
      const dshPath = found?.trim().split(/\r?\n/)[0]
      if (dshPath && !dshPath.toLowerCase().endsWith('.ps1')) {
        this.executable = { command: dshPath, args: [] }
        return this.executable
      }
    } catch {
      /* noop */
    }

    throw new Error(
      '未找到 dsh 可执行文件。请先安装 DeepSeek Harness（npm i -g @deepseek-ai/dsh），' +
        '或设置 DSH_EXECUTABLE 环境变量指向 dsh 入口。'
    )
  }

  /** 解析可用的 node 可执行文件：内置运行时（阶段 B）→ DSH_NODE → 系统 node */
  private async resolveNode(): Promise<string> {
    if (this.nodeExe) return this.nodeExe
    // 1) 内置 Node 运行时（阶段 B：真零门槛，原生模块 ABI 兼容）
    const embedded = runtimeManager.getNodeExe()
    if (embedded) {
      this.nodeExe = embedded
      logger.info('node resolved via embedded runtime', { node: embedded })
      return embedded
    }
    // 2) 显式指定 / 系统 node
    const candidates: string[] = []
    if (process.env.DSH_NODE) candidates.push(process.env.DSH_NODE)
    try {
      const found = await this.execCapture('where', ['node'])
      const nodePath = found?.trim().split(/\r?\n/)[0]
      if (nodePath) candidates.push(nodePath)
    } catch {
      /* noop */
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this.nodeExe = c
        return c
      }
    }
    throw new Error('未找到可用的 Node.js 运行时。请安装 Node.js，或在「内核」面板一键下载内置运行时。')
  }

  private execCapture(cmd: string, args: string[], opts: { shell?: boolean } = {}): Promise<string | null> {
    return new Promise((resolvePromise) => {
      execFile(cmd, args, { windowsHide: true, timeout: 10_000, shell: opts.shell ?? false }, (err, stdout) => {
        if (err) {
          resolvePromise(null)
          return
        }
        resolvePromise(stdout)
      })
    })
  }

  /** 并发防护入口：进行中的 start() 复用同一实例（H2） */
  async start(): Promise<void> {
    if (this.startInFlight) {
      logger.info('dsh start already in flight, awaiting')
      await this.startInFlight
      return
    }
    this.startInFlight = this.doStart()
    try {
      await this.startInFlight
    } finally {
      this.startInFlight = null
    }
  }

  private async doStart(): Promise<void> {
    if (this.child && this.pid !== null && this.status !== 'stopped' && this.status !== 'error') {
      logger.info('dsh already running, skip start')
      return
    }
    this.stopping = false
    // H1: 崩溃计数不再在此无条件重置（改为 onExit 按稳定运行时长判定），避免 >=MAX 上限失效
    this.lastError = null
    this.stdoutBuffer = ''
    // H5: 新进程的认证 URL 尚未打印，先清空（避免复用上一代进程的过期 token）
    this.webUrl = null
    this.setStatus('starting')

    try {
      const exe = await this.resolveExecutable()
      this.dshHome = this.resolveDshHome()
      const cfg = configStore.get()
      const portArg = cfg.port > 0 && cfg.port < 65536 ? String(cfg.port) : '0'
      const args = [...exe.args, 'web', '--host', '127.0.0.1', '--port', portArg, '--no-open']

      logger.info(`spawning dsh web`, { command: exe.command, args, dshHome: this.dshHome })
      const child = spawn(exe.command, args, {
        env: {
          ...process.env,
          ...(this.dshHome ? { DSH_HOME: this.dshHome } : {})
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.child = child
      this.pid = child.pid ?? null
      this.startedAt = Date.now()

      child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk, child))
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) logger.debug('[dsh stderr]', text)
      })
      child.on('error', (err) => {
        this.lastError = err.message
        logger.error('dsh spawn error', err.message)
        this.setStatus('error')
      })
      child.on('exit', (code, signal) => this.onExit(code, signal, child))
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      logger.error('dsh start failed', this.lastError)
      this.setStatus('error')
    }
  }

  private onStdout(chunk: Buffer, child: ChildProcess): void {
    // H2: 只处理当前代子进程的输出，忽略旧进程晚到的数据
    if (this.child !== child) return
    this.stdoutBuffer += chunk.toString()
    // 只保留最后 4KB，防止无限增长
    if (this.stdoutBuffer.length > 8192) this.stdoutBuffer = this.stdoutBuffer.slice(-4096)

    // 逐行处理
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      logger.debug('[dsh stdout]', t)
      // H5: 完整 URL（老内核无 token；alpha 内核带 ?token=…）——先于端口解析保存
      const um = t.match(WEB_URL_RE)
      if (um) this.webUrl = um[1]
      const m = t.match(PORT_RE)
      if (m) {
        const port = Number(m[1])
        if (port !== this.port) {
          this.port = port
          logger.info('dsh listening', { port })
        }
        this.beginHealthCheck(port)
      }
      // 版本行：dsh v0.1.1-rc.2 ...
      const vm = t.match(/dsh v?([\w.\-+]+)/i)
      if (vm && !this.version) {
        this.version = vm[1]
      }
    }
  }

  /** 健康检查：HTTP 轮询任一候选路径直到成功，期间保持 starting */
  private beginHealthCheck(port: number): void {
    // R-4: 自调度 setTimeout 链（完成后再排下一次），避免 interval 回调重叠堆积探测请求
    if (this.healthTimer) {
      clearTimeout(this.healthTimer)
      this.healthTimer = null
    }
    const deadline = Date.now() + READY_TIMEOUT_MS
    const tick = (): void => {
      void (async () => {
        try {
          const ok = await this.checkHealth(port)
          if (ok && this.status === 'starting') {
            this.healthTimer = null
            this.port = port
            // H1: 记录稳定运行起点（用于崩溃循环 vs 稳定后崩溃的判定）
            this.stableSince = Date.now()
            this.setStatus('running')
            return
          }
          if (Date.now() > deadline) {
            this.healthTimer = null
            this.lastError = '健康检查超时（' + READY_TIMEOUT_MS / 1000 + 's）'
            logger.error('dsh health check timeout', { port })
            this.setStatus('error')
            return
          }
        } catch {
          /* 轮询期间失败继续重试 */
        }
        // 下一轮
        this.healthTimer = setTimeout(tick, 800)
      })()
    }
    this.healthTimer = setTimeout(tick, 0)
  }

  private checkHealth(port: number): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const tryPath = (idx: number): void => {
        if (idx >= HEALTH_PATHS.length) {
          resolvePromise(false)
          return
        }
        const req = http.get(
          { host: '127.0.0.1', port, path: HEALTH_PATHS[idx], timeout: 1_500 },
          (res) => {
            res.resume()
            resolvePromise(res.statusCode !== undefined && res.statusCode < 500)
          }
        )
        req.on('timeout', () => {
          req.destroy()
          tryPath(idx + 1)
        })
        req.on('error', () => tryPath(idx + 1))
      }
      tryPath(0)
    })
  }

  private onExit(code: number | null, signal: string | null, child: ChildProcess): void {
    // H2: 只处理当前代子进程的退出，忽略旧进程（并发 start 泄漏的）exit 事件
    if (this.child !== child) {
      logger.debug('stale dsh child exit ignored', { code, signal })
      return
    }
    this.pid = null
    this.port = null
    // H5: 进程已退出，其认证 URL/token 随之失效
    this.webUrl = null
    this.child = null
    if (this.healthTimer) {
      clearTimeout(this.healthTimer)
      this.healthTimer = null
    }
    const wasStopping = this.stopping
    logger.warn('dsh process exited', { code, signal, stopping: wasStopping })

    if (wasStopping) {
      this.stopping = false
      this.setStatus('stopped')
      return
    }
    // H1: 崩溃计数——稳定运行 >=STABLE_RESET_MS 后再崩溃视为新一轮（重置为 1）；
    //     否则连续崩溃循环中持续累加，达到 MAX_RESTARTS 后停止自动重启（上限真实生效）
    if (this.restartCount === 0 || (this.stableSince !== null && Date.now() - this.stableSince >= STABLE_RESET_MS)) {
      this.restartCount = 1
    } else {
      this.restartCount += 1
    }
    if (this.restartCount >= MAX_RESTARTS) {
      this.lastError = '连续崩溃超过 ' + MAX_RESTARTS + ' 次，停止自动重启（请检查 DSH 内核配置或查看日志）'
      this.setStatus('error')
      return
    }
    // 指数退避：3s -> 6s -> 12s -> ... -> 封顶 60s
    const delay = Math.min(RESTART_BACKOFF_MS * 2 ** (this.restartCount - 1), RESTART_BACKOFF_MAX_MS)
    this.setStatus('starting')
    logger.warn('dsh crashed, restarting (attempt ' + this.restartCount + ', backoff ' + delay + 'ms)')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start()
    }, delay)
  }

  async stop(): Promise<void> {
    // H2: 等待进行中的 start 完成，避免 start 中途被 stop 的竞态
    if (this.startInFlight) {
      try {
        await this.startInFlight
      } catch {
        /* noop */
      }
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.healthTimer) {
      clearTimeout(this.healthTimer)
      this.healthTimer = null
    }
    if (!this.child || this.child.pid === undefined) {
      // H1: 手动停止后重置崩溃计数（下一次启动视为新一轮）
      this.restartCount = 0
      this.stableSince = null
      // 无运行中进程也要失效缓存：崩溃残留的旧入口/旧版本号不得被下一次 start 复用
      this.invalidateKernelCache()
      this.setStatus('stopped')
      return
    }
    this.stopping = true
    const pid = this.child.pid
    logger.info('stopping dsh', { pid })
    this.child.kill()

    // 等待退出；3 秒后强制结束进程树（dsh 可能派生子进程）
    await new Promise<void>((resolvePromise) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        const alive = this.isPidAlive(pid)
        if (!alive) {
          clearInterval(iv)
          resolvePromise()
        } else if (Date.now() - t0 > 3_000) {
          clearInterval(iv)
          this.killTree(pid)
          resolvePromise()
        }
      }, 200)
    })
    // 清理 Timer，避免悬挂
    this.stopping = false
    // H1: 停止成功后重置崩溃计数与稳定起点
    this.restartCount = 0
    this.stableSince = null
    // 服务已完全停止：失效内核/运行时缓存（切换内核后 restart 会重新解析新入口并重探测版本）
    this.invalidateKernelCache()
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private killTree(pid: number): void {
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
        /* noop */
      })
    } catch {
      /* noop */
    }
  }

  /**
   * 失效内核/运行时缓存：切换托管内核（默认版本/模式/Profile 绑定）后必须重新解析
   * 入口并重探测版本，否则 restart 会复用缓存的旧 executable/nodeExe/version，
   * 导致新内核不生效且标题栏/状态页版本号不刷新。
   */
  invalidateKernelCache(): void {
    this.executable = null
    this.nodeExe = null
    this.version = null
    // H5: 停止后旧进程的认证 URL 不再有效，下一次 start 会重新解析新 URL
    this.webUrl = null
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
    // 切换内核后基于新入口重探测版本并推送（新进程 stdout 版本行可能延迟/缺失；
    // stop 已清 version 缓存，此处必然走 --version 重新探测）
    void this.readVersion().then((v) => {
      if (v) this.emit('statusChange', this.getState())
    })
  }

  async readVersion(): Promise<string | null> {
    if (this.version) return this.version
    try {
      const exe = await this.resolveExecutable()
      const out = await this.execCapture2(exe, [...exe.args, '--version'])
      const t = out.trim()
      this.version = t || null
      return this.version
    } catch (err) {
      logger.warn('read dsh version failed', err)
      return null
    }
  }

  /** 执行任意 dsh 子命令（如 plugin），返回输出；超时自动终止 */
  async execDsh(args: string[], timeoutMs = 120_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const exe = await this.resolveExecutable()
    const dshHome = this.dshHome ?? this.resolveDshHome()
    return new Promise((resolvePromise) => {
      const child = spawn(exe.command, [...exe.args, ...args], {
        env: {
          ...process.env,
          DSH_HOME: dshHome
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString()
        logger.debug('[dsh exec]', c.toString().trim())
      })
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString()
        logger.debug('[dsh exec stderr]', c.toString().trim())
      })
      const timer = setTimeout(() => {
        logger.warn('dsh exec timeout, killing', { args })
        this.killTree(child.pid ?? 0)
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

  private execCapture2(exe: { command: string; args: string[] }, fullArgs: string[]): Promise<string> {
    return new Promise((resolvePromise) => {
      const child = spawn(exe.command, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let acc = ''
      let settled = false
      child.stdout?.on('data', (c: Buffer) => (acc += c.toString()))
      const timer = setTimeout(() => {
        // R-18: 超时也归还已收集输出（防止 close 不触发导致 Promise 永不 resolve）
        if (!child.killed) child.kill()
        if (!settled) { settled = true; resolvePromise(acc) }
      }, 10_000)
      child.on('close', () => {
        clearTimeout(timer)
        if (!settled) { settled = true; resolvePromise(acc) }
      })
      child.on('error', () => {
        clearTimeout(timer)
        if (!settled) { settled = true; resolvePromise('') }
      })
    })
  }

  /** R-2: 退出前同步强杀进程树（不等异步 stop，保证 dsh 孙进程/端口也被清理） */
  killTreeNow(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.healthTimer) {
      clearTimeout(this.healthTimer)
      this.healthTimer = null
    }
    const pid = this.child?.pid
    if (pid) {
      try {
        this.child?.kill()
      } catch {
        /* noop */
      }
      this.killTree(pid)
    }
  }

  async shutdown(): Promise<void> {
    this.killTreeNow()
    await this.stop()
  }
}

export const dshManager = new DSHManager()