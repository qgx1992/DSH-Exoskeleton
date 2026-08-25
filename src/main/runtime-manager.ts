/**
 * 内置 Node 运行时管理（设计文档 docs/KERNEL-MANAGER-DESIGN.md §4.4，阶段 B）
 * - 目标：全新机器无 Node/npm 也能运行托管内核（真零门槛）
 * - 下载：nodejs.org dist（node-v<ver>-win-<arch>.zip），动态解析最新 LTS（>=24）
 * - 解压：Windows 10+ 自带 tar.exe（bsdtar 支持 zip），失败回退 PowerShell Expand-Archive
 * - 自检：node --version 输出与目标版本一致后完成
 * - 路由：DSHManager.resolveNode() / KernelManager.resolveNode() 内置运行时优先
 * - 镜像：DSH_NODE_DIST 环境变量可覆盖下载源（如 npmmirror），便于国内网络
 */
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { logger } from './logger'
import type { KernelProgress, RuntimeInfo } from '../shared/types'

/** 官方下载源（可用 DSH_NODE_DIST 覆盖为镜像） */
const NODE_DIST = process.env.DSH_NODE_DIST || 'https://nodejs.org/dist'
/** index.json 解析失败时的兜底版本（已确认存在的 LTS，满足 dsh engines >=24） */
const FALLBACK_VERSION = 'v24.14.0'
/** 下载超时（无数据 60s 视为断线） */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000

export class RuntimeManager extends EventEmitter {
  private runtimesDir = ''
  private busy: RuntimeInfo['busy'] = 'idle'

  init(): void {
    this.runtimesDir = path.join(app.getPath('userData'), 'runtimes')
    fs.mkdirSync(this.runtimesDir, { recursive: true })
  }

  getRuntimeDir(): string {
    return this.runtimesDir
  }

  /** 内置 node.exe 路径（未安装返回 null） */
  getNodeExe(): string | null {
    const p = path.join(this.runtimesDir, 'node', 'node.exe')
    return fs.existsSync(p) ? p : null
  }

  private emitProgress(p: Omit<KernelProgress, 'version'>): void {
    this.emit('progress', { version: 'runtime', ...p })
  }

  /** 读取内置运行时版本（未安装返回 null） */
  async readVersion(): Promise<string | null> {
    const exe = this.getNodeExe()
    if (!exe) return null
    try {
      const out = await new Promise<string>((resolvePromise) => {
        const child = spawn(exe, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let acc = ''
        child.stdout?.on('data', (c: Buffer) => (acc += c.toString()))
        child.on('close', () => resolvePromise(acc.trim()))
        child.on('error', () => resolvePromise(''))
      })
      return out || null
    } catch {
      return null
    }
  }

  async status(): Promise<RuntimeInfo> {
    const exe = this.getNodeExe()
    return {
      installed: !!exe,
      version: exe ? await this.readVersion() : null,
      path: exe,
      systemNode: await this.resolveSystemNode(),
      busy: this.busy
    }
  }

  /** 探测系统 Node（DSH_NODE / PATH 中的 node） */
  private resolveSystemNode(): Promise<string | null> {
    return new Promise((resolvePromise) => {
      const candidates: string[] = []
      if (process.env.DSH_NODE) candidates.push(process.env.DSH_NODE)
      execFile('where', ['node'], { windowsHide: true, timeout: 8_000 }, (err, stdout) => {
        if (!err && stdout) candidates.push(...stdout.split(/\r?\n/).map((s) => s.trim()))
        for (const c of candidates) {
          if (fs.existsSync(c)) {
            resolvePromise(c)
            return
          }
        }
        resolvePromise(null)
      })
    })
  }

  /** 解析应下载的 Node 版本：index.json 最新 LTS（major>=24），失败兜底常量 */
  private async latestVersion(): Promise<string> {
    try {
      const res = await fetch(NODE_DIST + '/index.json', { signal: AbortSignal.timeout(15_000) })
      if (res.ok) {
        const data = (await res.json()) as Array<{ version: string; lts: string | false }>
        for (const item of data) {
          if (item.lts === false) continue
          const major = Number(item.version.slice(1).split('.')[0])
          if (major >= 24) return item.version
        }
      }
    } catch (err) {
      logger.warn('node index.json fetch failed, using fallback', err)
    }
    return FALLBACK_VERSION
  }

  /** 磁盘剩余空间（MB）；失败返回 -1 */
  diskFreeMB(): number {
    try {
      const st = fs.statfsSync(this.runtimesDir)
      return Math.floor((st.bavail * st.bsize) / (1024 * 1024))
    } catch {
      return -1
    }
  }

  /** 下载并安装内置 Node 运行时（进度事件推送） */
  async download(): Promise<{ ok: boolean; error?: string }> {
    if (this.busy !== 'idle') return { ok: false, error: '运行时操作进行中' }
    if (this.getNodeExe()) return { ok: false, error: '内置 Node 运行时已安装' }

    this.busy = 'downloading'
    this.emitProgress({ stage: 'downloading', percent: 2, message: '获取 Node 版本信息…' })
    try {
      const ver = await this.latestVersion()
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
      const zipName = 'node-' + ver + '-win-' + arch + '.zip'
      const url = NODE_DIST + '/' + ver + '/' + zipName
      const dir = this.runtimesDir
      const zipPath = path.join(dir, zipName + '.' + crypto.randomBytes(4).toString('hex') + '.tmp')

      logger.info('node runtime download start', { url, to: dir })

      // 1) 下载（流式 + 进度）
      await this.downloadFile(url, zipPath, (percent) => {
        this.emitProgress({
          stage: 'downloading',
          percent: 2 + percent * 0.86,
          message: '下载 Node ' + ver + '（' + (percent * 100).toFixed(0) + '%）'
        })
      })

      // 2) 解压
      this.busy = 'extracting'
      const extractDir = path.join(dir, '.extract-' + crypto.randomBytes(4).toString('hex'))
      fs.mkdirSync(extractDir, { recursive: true })
      this.emitProgress({ stage: 'extracting', percent: 90, message: '解压 Node 运行时…' })
      const ok = await this.extractZip(zipPath, extractDir)
      if (!ok) throw new Error('解压失败（tar/Expand-Archive 均不可用）')

      // 3) 移动 node-v*-win-*/ 到 node/
      const inner = fs.readdirSync(extractDir).find((n) => n.startsWith('node-v') && n.includes('-win-'))
      if (!inner) throw new Error('解压产物结构异常')
      const target = path.join(dir, 'node')
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
      fs.renameSync(path.join(extractDir, inner), target)
      fs.rmSync(extractDir, { recursive: true, force: true })
      fs.rmSync(zipPath, { force: true })

      // 4) 自检
      const got = await this.readVersion()
      if (!got) throw new Error('运行时自检失败：node --version 无输出')
      if (!got.startsWith(ver.slice(0, 4))) {
        throw new Error('运行时自检异常：期望 ' + ver + '，实际 ' + got)
      }
      this.emitProgress({ stage: 'done', percent: 100, message: '内置 Node ' + got + ' 就绪' })
      logger.info('node runtime installed', { version: got, dir: target })
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 清理残留
      try {
        for (const f of fs.readdirSync(this.runtimesDir)) {
          if (f.startsWith('.extract-') || f.endsWith('.tmp')) fs.rmSync(path.join(this.runtimesDir, f), { recursive: true, force: true })
        }
      } catch {
        /* noop */
      }
      this.emitProgress({ stage: 'error', percent: 0, message: msg })
      logger.error('node runtime download failed', { error: msg })
      return { ok: false, error: msg }
    } finally {
      this.busy = 'idle'
    }
  }

  /** 删除内置运行时 */
  async remove(): Promise<{ ok: boolean; error?: string }> {
    if (this.busy !== 'idle') return { ok: false, error: '运行时操作进行中' }
    const target = path.join(this.runtimesDir, 'node')
    if (!fs.existsSync(target)) return { ok: false, error: '内置 Node 运行时未安装' }
    this.busy = 'removing'
    this.emitProgress({ stage: 'removing', percent: 50, message: '删除内置 Node 运行时…' })
    try {
      fs.rmSync(target, { recursive: true, force: true })
      this.emitProgress({ stage: 'done', percent: 100, message: '内置 Node 运行时已删除' })
      logger.info('node runtime removed')
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitProgress({ stage: 'error', percent: 0, message: msg })
      return { ok: false, error: msg }
    } finally {
      this.busy = 'idle'
    }
  }

  /** 流式下载文件并报告进度（0~1） */
  private downloadFile(url: string, dest: string, onProgress: (p: number) => void): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const mod = url.startsWith('https:') ? https : http
      const req = mod.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 重定向
          this.downloadFile(res.headers.location, dest, onProgress).then(resolvePromise, rejectPromise)
          return
        }
        if (!res.statusCode || res.statusCode >= 400) {
          rejectPromise(new Error('下载失败 HTTP ' + (res.statusCode ?? '?')))
          return
        }
        const total = Number(res.headers['content-length'] ?? 0)
        let received = 0
        let lastReport = 0
        const out = fs.createWriteStream(dest)
        let idleTimer: NodeJS.Timeout | null = null
        const arm = (): void => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            req.destroy(new Error('下载超时（无数据）'))
          }, DOWNLOAD_IDLE_TIMEOUT_MS)
        }
        arm()
        res.on('data', (c: Buffer) => {
          received += c.length
          arm()
          if (total > 0 && received - lastReport > 512 * 1024) {
            lastReport = received
            onProgress(received / total)
          }
        })
        out.on('error', (err) => rejectPromise(err))
        out.on('finish', () => {
          if (idleTimer) clearTimeout(idleTimer)
          onProgress(1)
          resolvePromise()
        })
        res.pipe(out)
      })
      req.on('error', (err) => rejectPromise(err))
    })
  }

  /** 解压 zip：优先 tar.exe（Windows 10+ 内置），失败回退 PowerShell Expand-Archive */
  private extractZip(zipPath: string, dest: string): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const tryTar = (): void => {
        const child = spawn('tar.exe', ['-xf', zipPath, '-C', dest], { windowsHide: true, stdio: 'ignore' })
        const t = setTimeout(() => {
          child.kill()
          tryExpand()
        }, 120_000)
        child.on('close', (code) => {
          clearTimeout(t)
          if (code === 0) resolvePromise(true)
          else tryExpand()
        })
        child.on('error', () => {
          clearTimeout(t)
          tryExpand()
        })
      }
      const tryExpand = (): void => {
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', "Expand-Archive -LiteralPath '" + zipPath + "' -DestinationPath '" + dest + "' -Force"], {
          windowsHide: true,
          stdio: 'ignore'
        })
        const t = setTimeout(() => {
          child.kill()
          resolvePromise(false)
        }, 300_000)
        child.on('close', (code) => {
          clearTimeout(t)
          resolvePromise(code === 0)
        })
        child.on('error', () => {
          clearTimeout(t)
          resolvePromise(false)
        })
      }
      tryTar()
    })
  }
}

export const runtimeManager = new RuntimeManager()
