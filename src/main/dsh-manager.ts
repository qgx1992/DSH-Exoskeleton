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
import type { DSHState } from '../shared/types'

const PORT_RE = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/i
const HEALTH_PATHS = ['/health', '/api/health', '/']
const READY_TIMEOUT_MS = 60_000
const RESTART_BACKOFF_MS = 3_000

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
  private healthTimer: NodeJS.Timeout | null = null

  getState(): DSHState {
    return {
      status: this.status,
      port: this.port,
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

  /**
   * 解析 dsh 可执行入口，探测顺序：
   * 1. DSH_EXECUTABLE 环境变量（显式指定，兼容打包自带/自定义安装）
   * 2. npm/pnpm 全局安装的 @deepseek-ai/dsh（bin.js 由 node 直接运行）
   * 3. PATH 中的 dsh/dsh.cmd（shell 方式）
   */
  private async resolveExecutable(): Promise<{ command: string; args: string[] }> {
    if (this.executable) return this.executable

    // ① 托管内核（kernelMode=managed 且 defaultKernelVersion 已安装）—— 多内核共存路由
    kernelManager.init()
    const cfg = configStore.get()
    if (cfg.kernelMode === 'managed' && cfg.defaultKernelVersion) {
      const binJs = kernelManager.binJsFor(cfg.defaultKernelVersion)
      if (binJs) {
        const nodeExe = await this.resolveNode()
        this.executable = { command: nodeExe, args: [binJs] }
        logger.info('dsh entry resolved via managed kernel', { version: cfg.defaultKernelVersion, binJs })
        return this.executable
      }
      logger.warn('managed kernel not ready, falling back to system dsh', { version: cfg.defaultKernelVersion })
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
      const prefix = await this.execCapture('npm', ['prefix', '-g'])
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

  /** 解析可用的 node 可执行文件：DSH_NODE / 系统 node / 应用自带 Electron Node */
  private async resolveNode(): Promise<string> {
    if (this.nodeExe) return this.nodeExe
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
    // 最后回退到应用自身（Electron 内置 Node，能力等同）
    this.nodeExe = process.execPath
    logger.info('fallback to app-embedded node', { node: this.nodeExe })
    return this.nodeExe
  }

  private execCapture(cmd: string, args: string[]): Promise<string | null> {
    return new Promise((resolvePromise) => {
      execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
        if (err) {
          resolvePromise(null)
          return
        }
        resolvePromise(stdout)
      })
    })
  }

  async start(): Promise<void> {
    if (this.child && this.pid !== null && this.status !== 'stopped' && this.status !== 'error') {
      logger.info('dsh already running, skip start')
      return
    }
    this.stopping = false
    this.restartCount = 0
    this.lastError = null
    this.stdoutBuffer = ''
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

      child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk))
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) logger.debug('[dsh stderr]', text)
      })
      child.on('error', (err) => {
        this.lastError = err.message
        logger.error('dsh spawn error', err.message)
        this.setStatus('error')
      })
      child.on('exit', (code, signal) => this.onExit(code, signal))
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      logger.error('dsh start failed', this.lastError)
      this.setStatus('error')
    }
  }

  private onStdout(chunk: Buffer): void {
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
    if (this.healthTimer) clearInterval(this.healthTimer)
    const deadline = Date.now() + READY_TIMEOUT_MS
    this.healthTimer = setInterval(async () => {
      try {
        const ok = await this.checkHealth(port)
        if (ok && this.status === 'starting') {
          clearInterval(this.healthTimer!)
          this.healthTimer = null
          this.port = port
          this.setStatus('running')
          return
        }
        if (Date.now() > deadline) {
          clearInterval(this.healthTimer!)
          this.healthTimer = null
          this.lastError = `健康检查超时（${READY_TIMEOUT_MS / 1000}s）`
          logger.error('dsh health check timeout', { port })
          this.setStatus('error')
        }
      } catch {
        /* 轮询期间失败继续重试 */
      }
    }, 800)
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

  private onExit(code: number | null, signal: string | null): void {
    this.pid = null
    this.port = null
    this.child = null
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
    const wasStopping = this.stopping
    logger.warn('dsh process exited', { code, signal, stopping: wasStopping })

    if (wasStopping) {
      this.stopping = false
      this.setStatus('stopped')
      return
    }
    // 崩溃自动重启（退避，最多连续 10 次）
    if (this.restartCount >= 10) {
      this.lastError = '连续崩溃超过 10 次，停止自动重启'
      this.setStatus('error')
      return
    }
    this.restartCount += 1
    this.setStatus('starting')
    logger.warn(`dsh crashed, restarting (attempt ${this.restartCount})`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start()
    }, RESTART_BACKOFF_MS)
  }

  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (!this.child || this.child.pid === undefined) {
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

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
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
      child.stdout?.on('data', (c: Buffer) => (acc += c.toString()))
      child.on('close', () => resolvePromise(acc))
      child.on('error', () => resolvePromise(''))
      setTimeout(() => {
        if (!child.killed) child.kill()
      }, 10_000)
    })
  }

  async shutdown(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    await this.stop()
  }
}

export const dshManager = new DSHManager()