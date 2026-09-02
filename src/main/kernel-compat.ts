/**
 * 内核兼容启动层（R-24）
 * - 补丁注册表：已知「与旧 profile 状态组合启动失败」的内核版本 → 生成官方一等机制
 *   `--patch <file>` 叠层（按行 id `disabled: true`），不修改内核目录、不写用户 ~/.dsh
 * - 试启动门禁：切换默认/档案绑定内核前，用「克隆 DSH_HOME」（复制 profile 清单 +
 *   junction 插件目录）实际拉起 `dsh web`，60s 内打印 URL 且健康检查通过才算可用；
 *   失败则拦截切换并记录 bootHealth=failed
 * 背景证据：官方 0.1.2-alpha.2 的 ui-deliverables 插件调用已淘汰的
 * `ctx.systemPrompt.getSectionOrder`；真实 profile 残留旧 dsh-system-prompt@0.1.2-alpha.1
 * （无该方法）时插件树加载崩溃；禁用该行即可兼容启动（运行时自证通过，见
 * docs/verify-alpha2-boot-selfcheck.md）
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { logger } from './logger'
import { kernelManager } from './kernel-manager'
import { runtimeManager } from './runtime-manager'

/** 内置兼容补丁注册表：key = 内核版本 → 需禁用的 loader 行 id 列表。
 * 注意：注册表只收录「实测需补丁」的版本；未收录版本（如 0.1.2-alpha.3 / alpha.4 / alpha.5）
 * 即表示无需补丁、以原样启动，无需添加条目（添加空条目反而会产生无效补丁文件）。
 * 验证记录：0.1.2-alpha.3 / alpha.4 / alpha.5 均已过本机试启动门禁（无补丁）且会话文件解析回归通过，
 * 见 scripts/probe/probe-newkernel-compat.cjs（支持传入版本号参数）与 scripts/probe/probe-alpha4-sessions.cjs。 */
export const COMPAT_PATCHES: Record<string, { rows: string[]; note: string }> = {
  '0.1.2-alpha.2': {
    rows: ['ui-deliverables', 'dsh-market', 'better-sidebar'],
    note: '官方 alpha.2 车次不兼容三处（均经试启动门禁实测定位）：' +
      '① dsh-client-ui-deliverables 调用已淘汰的 ctx.systemPrompt.getSectionOrder ' +
      '（profile 残留旧 dsh-system-prompt@0.1.2-alpha.1 时插件树崩溃）；' +
      '②③ dshmarket / dsh-better-sidebar 依赖 @deepseek-ai/dsh-settings 的旧导出 ' +
      'installSettingsSection / settingsNamespace，而 alpha.2 已移除。禁用上述行可兼容启动' +
      '（期间对应 UI 特性缺失）。根治方向：profile 固定安装 @deepseek-ai/dsh-settings@0.1.1-rc.2' +
      '（满足插件 peer 声明）或等官方/插件适配；门禁会如实报告下一位失败者。'
  }
}

export interface TrialBootResult {
  ok: boolean
  /** 试启动打印的 Web UI URL（成功时为 http://127.0.0.1:PORT/?token=…） */
  url: string | null
  /** 是否携带兼容补丁 --patch 启动 */
  patchUsed: boolean
  stdout: string
  stderr: string
  /** 失败摘要（失败时非空） */
  error: string | null
}

/** 兼容补丁目录（userData/kernel-patches/），base 可注入便于测试 */
export function compatPatchDirFor(userDataDir: string): string {
  return path.join(userDataDir, 'kernel-patches')
}

export function compatPatchDir(): string {
  return compatPatchDirFor(app.getPath('userData'))
}

/**
 * 确保内置补丁文件落盘（幂等；临时文件 + rename，R-3 风格）。
 * 注册表内容变化（如新增禁行）时自动重写旧文件，避免「旧补丁文件挡住新内容」。
 * 返回补丁文件路径；该版本无需补丁时返回 null。
 */
export function ensureCompatPatch(version: string): string | null {
  const spec = COMPAT_PATCHES[version]
  if (!spec) return null
  const dir = compatPatchDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, version + '.yml')
  const body = spec.rows.map((id) => `- id: ${id}\n  disabled: true`).join('\n') + '\n'
  let existing: string | null = null
  try {
    if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf-8')
  } catch {
    existing = null
  }
  if (existing !== body) {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, body, 'utf-8')
    fs.renameSync(tmp, file)
    logger.info('kernel compat patch written', { version, file, rows: spec.rows })
  }
  return file
}

/** 目标版本需要的 --patch 参数（无补丁返回空数组） */
export function compatPatchArgsFor(version: string): string[] {
  const file = ensureCompatPatch(version)
  return file ? ['--patch', file] : []
}

/** 目标版本当前应使用的补丁文件路径（无 → null） */
export function compatPatchPathFor(version: string): string | null {
  return ensureCompatPatch(version)
}

/** 克隆 DSH_HOME 供试启动：复制 profile 清单/补丁层，junction 引用插件目录（不写入线上目录） */
export function cloneProfileHome(dshHome: string, profileName = 'web'): { home: string; cleanup: () => void } {
  const realProfile = path.join(dshHome, 'profiles', profileName)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-probe-'))
  const cloneProfile = path.join(home, 'profiles', profileName)
  fs.mkdirSync(cloneProfile, { recursive: true })
  // profile 层：清单 + 用户补丁 +（如有）pnpm 供应链白名单
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    const src = path.join(realProfile, name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(cloneProfile, name))
  }
  // 插件依赖目录：junction 只读引用（Windows junction 无需管理员权限）
  const realNm = path.join(realProfile, 'node_modules')
  if (fs.existsSync(realNm)) {
    try {
      fs.symlinkSync(realNm, path.join(cloneProfile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (err) {
      logger.warn('compat probe: profile node_modules junction failed, boot may differ from production', err)
      fs.mkdirSync(path.join(cloneProfile, 'node_modules'), { recursive: true })
    }
  }
  // 维护兜底层 $DSH_HOME/profiles/node_modules（官方文档：裸插件名解析路径）
  // 注意：必须【复制】而非 junction——被测内核启动时会 heal 重建这个目录里的链接
  // （moduleFallback），junction 会把被测内核写的链接直接落回真实目录（v0.8.3 实测：
  // trialBoot 0.1.1 把第二锚点 dsh-client-runtime/dsh-host-apiproxy 改写指向 0.1.1，
  // 污染扩散到第一锚点，导致 alpha.2 下 cost-meter typert 校验失败崩溃）。
  // 复制链接到克隆目录（目标不变），被测内核 heal 只影响克隆副本。
  const realFallback = path.join(dshHome, 'profiles', 'node_modules')
  if (fs.existsSync(realFallback)) {
    try {
      const cloneFallback = path.join(home, 'profiles', 'node_modules')
      fs.mkdirSync(cloneFallback, { recursive: true })
      for (const e of fs.readdirSync(realFallback, { withFileTypes: true })) {
        if (!e.isSymbolicLink()) continue
        try {
          const target = fs.readlinkSync(path.join(realFallback, e.name))
          fs.symlinkSync(target, path.join(cloneFallback, e.name), process.platform === 'win32' ? 'junction' : 'dir')
        } catch {
          /* noop */
        }
      }
    } catch (err) {
      logger.warn('compat probe: profile fallback copy failed, boot may differ from production', err)
    }
  }
  // home 级用户补丁层（$DSH_HOME/cordis.patch.yml，机器级偏好）
  const homePatch = path.join(dshHome, 'cordis.patch.yml')
  if (fs.existsSync(homePatch)) fs.copyFileSync(homePatch, path.join(home, 'cordis.patch.yml'))
  return {
    home,
    cleanup: () => {
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* noop */
      }
    }
  }
}

/** 解析试启动用的 Node：内置运行时 → DSH_NODE → 系统 where node */
async function resolveNodeExe(): Promise<string | null> {
  const embedded = runtimeManager.getNodeExe()
  if (embedded && fs.existsSync(embedded)) return embedded
  if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) return process.env.DSH_NODE
  const out = await execFileAsync('where', ['node'], 8_000)
  const p = out?.trim().split(/\r?\n/)[0]
  if (p && fs.existsSync(p)) return p
  return null
}

function execFileAsync(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout) => {
      resolvePromise(err ? null : stdout)
    })
  })
}

/** 强制结束进程树（Windows taskkill /T /F；其他平台 SIGKILL 进程组） */
function killTree(pid: number): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* noop */ })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {
    /* noop */
  }
}

/**
 * 试启动门禁（R-24）：在克隆 DSH_HOME 上实际拉起目标内核的 `dsh web`，
 * 携带兼容补丁（若注册表有），等待 `dsh web: http://…` 输出 + 健康检查通过。
 * 全程不触碰线上 DSH_HOME 与运行中服务。
 */
export async function trialBootManagedKernel(
  version: string,
  dshHome: string,
  opts: { timeoutMs?: number; patchPaths?: string[] | null } = {}
): Promise<TrialBootResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  try {
    kernelManager.init()
    const binJs = kernelManager.binJsFor(version)
    if (!binJs) {
      return { ok: false, url: null, patchUsed: false, stdout: '', stderr: '', error: 'bin.js 不存在（内核未安装完整）' }
    }
    const nodeExe = await resolveNodeExe()
    if (!nodeExe) {
      return { ok: false, url: null, patchUsed: false, stdout: '', stderr: '', error: '未找到可用的 Node.js 运行时' }
    }
    // patchPaths：undefined=按注册表注入；null/[]=不带补丁；显式数组=指定补丁
    const patchArgs = opts.patchPaths === undefined ? compatPatchArgsFor(version) : (opts.patchPaths ?? [])
    const patchUsed = patchArgs.length > 0
    const clone = cloneProfileHome(dshHome)
    // R-24 门禁环境对齐：试启动前先把真实第一锚点（profiles/web/node_modules/@deepseek-ai）
    // relink 到被测内核（克隆目录 junction 引用真实目录，自动跟随）——实际切换后 doStart
    // 也会这么干，门禁因此测的是与真实启动完全一致的环境（避免"门禁说行/实际不行"失真）。
    // 先快照原链接，结束后 restoreProfileAnchor 精确还原（路径形式不变，无副作用）。
    const anchorSnapshot = kernelManager.snapshotProfileAnchor()
    try {
      kernelManager.relinkProfileAnchor(version)
    } catch (err) {
      logger.warn('kernel trial boot: relink profile anchor failed', err)
    }
    const args = [binJs, 'web', ...patchArgs, '--host', '127.0.0.1', '--port', '0', '--no-open']
    logger.info('kernel trial boot', { version, patchUsed, patchArgs, cloneHome: clone.home })

    const child = spawn(nodeExe, args, {
      env: { ...process.env, DSH_HOME: clone.home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdoutBuf = ''
    let stderrBuf = ''
    let stdoutCap = ''
    let stderrCap = ''
    child.stdout?.on('data', (c: Buffer) => {
      stdoutBuf += c.toString()
      if (stdoutBuf.length > 16_384) stdoutBuf = stdoutBuf.slice(-8192)
      stdoutCap = (stdoutCap + c.toString()).slice(-8192)
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderrBuf += c.toString()
      if (stderrBuf.length > 16_384) stderrBuf = stderrBuf.slice(-8192)
      stderrCap = (stderrCap + c.toString()).slice(-8192)
    })

    const urlRe = /dsh web: (https?:\/\/\S+)/i
    const deadline = Date.now() + timeoutMs
    let result: TrialBootResult | null = null

    while (Date.now() < deadline) {
      const m = stdoutBuf.match(urlRe) ?? stdoutCap.match(urlRe)
      if (m) {
        const url = m[1]
        const healthy = await httpHealthy(url, 5_000)
        result = {
          ok: healthy,
          url,
          patchUsed,
          stdout: stdoutCap,
          stderr: stderrCap,
          error: healthy ? null : 'URL 已打印但健康检查未通过'
        }
        break
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const code = child.exitCode
        result = {
          ok: false,
          url: null,
          patchUsed,
          stdout: stdoutCap,
          stderr: stderrCap,
          error: summarizeBootFailure(stdoutCap, stderrCap, code)
        }
        break
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!result) {
      result = { ok: false, url: null, patchUsed, stdout: stdoutCap, stderr: stderrCap, error: `试启动超时（>${timeoutMs / 1000}s 未就绪）` }
    }
    if (child.exitCode === null && child.signalCode === null) killTree(child.pid ?? 0)
    clone.cleanup()
    // 门禁无副作用：按快照精确还原第一锚点链接（路径形式不变）
    kernelManager.restoreProfileAnchor(anchorSnapshot)
    return result
  } catch (err) {
    return {
      ok: false,
      url: null,
      patchUsed: false,
      stdout: '',
      stderr: '',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** URL 出现后健康检查：任一候选路径 <500 视为通过（与 dsh-manager 判定一致） */
function httpHealthy(url: string, budgetMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let port = 0
    try {
      port = new URL(url).port ? Number(new URL(url).port) : 80
    } catch {
      resolvePromise(false)
      return
    }
    const paths = ['/health', '/api/health', '/']
    const deadline = Date.now() + budgetMs
    const tryOnce = (): void => {
      const tryPath = (idx: number): void => {
        if (idx >= paths.length) {
          if (Date.now() < deadline) setTimeout(tryOnce, 500)
          else resolvePromise(false)
          return
        }
        const req = http.get({ host: '127.0.0.1', port, path: paths[idx], timeout: 1_500 }, (res) => {
          res.resume()
          resolvePromise(res.statusCode !== undefined && res.statusCode < 500)
        })
        req.on('timeout', () => {
          req.destroy()
          tryPath(idx + 1)
        })
        req.on('error', () => tryPath(idx + 1))
      }
      tryPath(0)
    }
    tryOnce()
  })
}

/** 从启动输出提炼失败摘要（优先 Error/失败描述行；最多 500 字符） */
function summarizeBootFailure(stdout: string, stderr: string, code: number | null): string {
  const lines = (stderr || stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const errLine =
    lines.find((l) => /^Error[: ]/i.test(l)) ??
    lines.find((l) => /failed to (apply|import)/i.test(l)) ??
    lines.find((l) => /is not a function|does not provide an export|Cannot find module/i.test(l)) ??
    lines[0]
  return (errLine ?? `dsh web 启动失败（exit ${code ?? '?'}）`).slice(0, 500)
}