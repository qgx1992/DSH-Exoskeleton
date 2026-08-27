/**
 * 插件管理器（文档 §4.3.3）
 * - 目录：GitHub topic:dsh-plugin + npm 搜索（双来源）
 * - 安装/卸载：复用 `dsh plugin --profile web add|remove <pkg>`（转发 pnpm）
 * - 冲突预检：同名已安装先报告
 * - 更新检测：npm dist-tags.latest / GitHub 最新发布 tag，与本地已装版本逐段比较（R-22）
 * - 升级：按来源重放 `dsh plugin add`（pnpm 解析最新），升级/安装/卸载前均自动备份
 * - 每次安装/卸载前自动创建备份快照（§4.3.4）
 */
import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import { backupManager } from './backup'
import { configStore } from './config'
import { compareVersions } from '../shared/version'
import { RECOMMENDED_PLUGINS } from '../shared/recommended-plugins'
import type { PluginCatalogItem, InstalledPlugin, PluginActionResult, PluginUpdateInfo } from '../shared/types'

const GITHUB_SEARCH = 'https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=40'
const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=30'
/** R-10: 插件安装/卸载互斥锁（同一 profile 并发操作会写坏依赖树） */
let pluginOpBusy = false

function profileDir(): string {
  return path.join(dshManager.resolveDshHome(), 'profiles', 'web')
}

/** 已安装插件：读 profile package.json dependencies + node_modules */
export function listInstalled(): InstalledPlugin[] {
  const dir = profileDir()
  const out: InstalledPlugin[] = []
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    const deps: Record<string, string> = pkg?.dependencies ?? {}
    for (const [name, version] of Object.entries(deps)) {
      out.push({ name, version: String(version), update: null })
    }
  } catch (err) {
    logger.warn('read installed plugins failed', err)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function nodeModulesDir(): string {
  return path.join(profileDir(), 'node_modules')
}

/** 读取某插件解析后的实际安装版本（node_modules/<name>/package.json，支持 scoped 包）；读不到返回 null */
function readInstalledVersion(name: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(nodeModulesDir(), name, 'package.json'), 'utf-8'))
    return typeof pkg?.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** 按声明 spec 推断插件来源 */
function detectSource(declared: string): PluginUpdateInfo['source'] {
  if (/^github:/i.test(declared)) return 'github'
  // gh-proxy / codeload 等 URL 形式：github 域名可出现在任意位置（如 gh-proxy.com 包裹 codeload.github.com）
  if (/https?:\/\//i.test(declared) && /(?:github\.com|codeload\.github\.com)/i.test(declared)) return 'github'
  if (/^(link|file):/i.test(declared)) return 'local'
  return 'npm'
}

/** 从声明 spec 提取 GitHub owner/repo（支持 github:owner/repo 与 github.com / codeload.github.com URL 两种形式） */
function parseGithubSpec(spec: string): { owner: string; repo: string } | null {
  const m = /^github:([^/]+)\/([^#/]+)/i.exec(spec.trim())
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') }
  const u = /(?:github\.com|codeload\.github\.com)\/([^/\s]+)\/([^/\s#?]+)/i.exec(spec)
  if (u) return { owner: u[1], repo: u[2].replace(/\.git$/, '') }
  return null
}

/** 去掉常见 Git tag 的前导 v/V，再进逐段比较 */
function stripVPrefix(v: string): string {
  return v.replace(/^[vV]/, '')
}

/** npm registry dist-tags.latest（R-12: 15s 超时；scoped 包需 %2F 编码路径） */
async function fetchNpmLatest(name: string): Promise<string | null> {
  const p = name.startsWith('@') ? '@' + name.slice(1).replace('/', '%2F') : name
  const res = await fetch(`https://registry.npmjs.org/${p}/latest`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error('npm registry ' + res.status)
  const data = (await res.json()) as { version?: string }
  return typeof data.version === 'string' ? data.version : null
}

/** GitHub 最新版本：优先 releases/latest；无 release 的仓库回退 tags 首条类 semver tag */
async function fetchGithubLatest(spec: string): Promise<string | null> {
  const gh = parseGithubSpec(spec)
  if (!gh) throw new Error('无法识别 GitHub 来源 spec')
  const { owner, repo } = gh
  const hdrs = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop' }
  const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: hdrs,
    signal: AbortSignal.timeout(15_000)
  })
  if (relRes.ok) {
    const rel = (await relRes.json()) as { tag_name?: string }
    if (rel.tag_name) return rel.tag_name
  }
  const tagRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/tags?per_page=10`, {
    headers: hdrs,
    signal: AbortSignal.timeout(15_000)
  })
  if (tagRes.ok) {
    const tags = (await tagRes.json()) as { name?: string }[]
    const v = tags.find((t) => t.name && /^\d+(\.\d+)*/.test(t.name.replace(/^[vV]/, '')))
    return v?.name ?? null
  }
  return null
}

/** 单个插件的更新检测（本地链接不联网；网络失败仅记录 error，不抛） */
async function detectPluginUpdate(name: string, declared: string): Promise<PluginUpdateInfo> {
  const info: PluginUpdateInfo = {
    declared,
    current: readInstalledVersion(name),
    latest: null,
    available: false,
    source: detectSource(declared),
    checkedAt: Date.now(),
    error: null
  }
  if (info.source === 'local') return info // link:/file: 本地路径插件无法远程检测
  try {
    info.latest = info.source === 'github' ? await fetchGithubLatest(declared) : await fetchNpmLatest(name)
    if (info.latest && info.current) {
      info.available = compareVersions(stripVPrefix(info.latest), stripVPrefix(info.current)) > 0
    }
  } catch (err) {
    info.error = err instanceof Error ? err.message : String(err)
    logger.warn('plugin update check failed', { name, error: info.error })
  }
  return info
}

/** 联网检测全部已安装插件的更新（逐插件容错：单个失败只标记 error，不拖垮整体） */
export async function checkPluginUpdates(): Promise<InstalledPlugin[]> {
  const list = listInstalled()
  await Promise.all(
    list.map(async (p) => {
      p.update = await detectPluginUpdate(p.name, p.version)
    })
  )
  return list
}

/** 目录：GitHub topic + npm 双来源 */
export async function listCatalog(query = ''): Promise<PluginCatalogItem[]> {
  const results: PluginCatalogItem[] = []
  const seen = new Set<string>()

  const push = (item: PluginCatalogItem): void => {
    const q = query.trim().toLowerCase()
    if (q && !item.name.toLowerCase().includes(q) && !item.description.toLowerCase().includes(q)) return
    if (seen.has(item.packageName)) return
    seen.add(item.packageName)
    results.push(item)
  }

  // GitHub topic
  try {
    // R-12: 网络黑洞时 15s 超时，避免面板永久转圈
    const res = await fetch(GITHUB_SEARCH, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop' },
      signal: AbortSignal.timeout(15_000)
    })
    if (res.ok) {
      const data = (await res.json()) as {
        items?: { full_name?: string; name?: string; description?: string | null; stargazers_count?: number; html_url?: string }[]
      }
      for (const it of data.items ?? []) {
        const pkgName = (it.full_name ?? it.name ?? '').split('/').pop() ?? ''
        if (!pkgName) continue
        push({
          packageName: pkgName,
          name: pkgName,
          description: it.description ?? '',
          version: null,
          stars: it.stargazers_count ?? 0,
          url: it.html_url ?? '',
          source: 'github'
        })
      }
    }
  } catch (err) {
    logger.warn('github catalog fetch failed', err)
  }

  // npm 搜索
  try {
    const res = await fetch(NPM_SEARCH, { signal: AbortSignal.timeout(15_000) })
    if (res.ok) {
      const data = (await res.json()) as {
        objects?: { package?: { name?: string; version?: string; description?: string; links?: { npm?: string } } }[]
      }
      for (const o of data.objects ?? []) {
        const p = o.package
        if (!p?.name) continue
        push({
          packageName: p.name,
          name: p.name,
          description: p.description ?? '',
          version: p.version ?? null,
          stars: 0,
          url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
          source: 'npm'
        })
      }
    }
  } catch (err) {
    logger.warn('npm catalog fetch failed', err)
  }

  // GitHub 在前、npm 在后；同名只留一个（优先 GitHub 条目，已去重）
  return results
}

/** 冲突预检 */
function conflictCheck(target: string, installed: InstalledPlugin[]): string | null {
  if (installed.some((i) => i.name === target)) {
    return `插件「${target}」已安装，请勿重复安装`
  }
  if (installed.some((i) => i.name.toLowerCase() === target.toLowerCase())) {
    return `检测到同名（忽略大小写）插件「${target}」已安装，存在重复注册风险`
  }
  return null
}

/** 安装插件：自动备份 → 冲突预检 → dsh plugin add（R-10: 互斥锁防并发写坏 profile） */
export async function installPlugin(pkg: string): Promise<PluginActionResult> {
  if (pluginOpBusy) return { ok: false, error: '插件操作进行中，请稍候' }
  const target = (pkg ?? '').trim()
  if (!target) return { ok: false, error: '包名不能为空' }
  const installed = listInstalled()
  const conflict = conflictCheck(target, installed)
  if (conflict) return { ok: false, error: conflict }

  pluginOpBusy = true
  try {
    // R-25: 操作前自动备份失败则中止（避免无保护直接改动 profile）
    const snap = await backupManager.autoSnapshot('plugin-install:' + target)
    if (!snap) return { ok: false, error: '操作前自动备份失败，已中止' }
    logger.info('installing plugin', { pkg: target })
    const r = await dshManager.execDsh(['plugin', '--profile', 'web', 'add', target])
    const output = (r.stdout + '\n' + r.stderr).trim()
    if (r.code === 0) {
      return { ok: true, output }
    }
    return { ok: false, error: '安装失败（exit ' + r.code + '）', output: output.slice(0, 2000) }
  } finally {
    pluginOpBusy = false
  }
}

/** 卸载插件（R-10: 与安装共享互斥锁） */
export async function uninstallPlugin(pkg: string): Promise<PluginActionResult> {
  if (pluginOpBusy) return { ok: false, error: '插件操作进行中，请稍候' }
  const target = (pkg ?? '').trim()
  if (!target) return { ok: false, error: '包名不能为空' }
  const installed = listInstalled()
  if (!installed.some((i) => i.name === target)) {
    return { ok: false, error: '插件「' + target + '」不在当前 profile 依赖中' }
  }

  pluginOpBusy = true
  try {
    // R-25: 操作前自动备份失败则中止
    const snap = await backupManager.autoSnapshot('plugin-uninstall:' + target)
    if (!snap) return { ok: false, error: '操作前自动备份失败，已中止' }
    logger.info('uninstalling plugin', { pkg: target })
    const r = await dshManager.execDsh(['plugin', '--profile', 'web', 'remove', target])
    const output = (r.stdout + '\n' + r.stderr).trim()
    if (r.code === 0) {
      return { ok: true, output }
    }
    return { ok: false, error: '卸载失败（exit ' + r.code + '）', output: output.slice(0, 2000) }
  } finally {
    pluginOpBusy = false
  }
}

/**
 * 升级插件到最新版：
 * - 自动备份（R-25）→ 按来源重放 `dsh plugin --profile web add <spec>`；
 * - npm 插件必须传**精确版本** `<name>@<latest>`：实测 `add <name>`（裸包名）与
 *   `add <name>@latest`（tag）对已存在的同级范围依赖都是 no-op（exit 0 但 `added 0`，
 *   pnpm 判 "Already up to date"），只有显式精确版本才强制解析并落地；
 * - GitHub 插件（`github:owner/repo`）重放原 spec 重解析默认分支最新；
 * - 本地链接（link:/file:）与 URL 固定提交（codeload/gh-proxy）来源无法远程升级，明确拒绝。
 */
export async function upgradePlugin(name: string, latest?: string): Promise<PluginActionResult> {
  if (pluginOpBusy) return { ok: false, error: '插件操作进行中，请稍候' }
  const target = (name ?? '').trim()
  if (!target) return { ok: false, error: '包名不能为空' }
  const installed = listInstalled()
  const p = installed.find((i) => i.name === target || i.name.toLowerCase() === target.toLowerCase())
  if (!p) return { ok: false, error: '插件「' + target + '」不在当前 profile 依赖中' }
  const isGithubRef = /^github:/i.test(p.version)
  const source = isGithubRef ? 'github' : detectSource(p.version)
  if (source === 'local') return { ok: false, error: '本地链接插件（link:）无远端来源，无法升级' }
  if (source === 'github' && !isGithubRef) {
    return { ok: false, error: '该插件由 URL 固定提交安装（版本被提交 sha 锁定），无法直接升级；请先卸载后重新安装最新版' }
  }
  if (!isGithubRef && !latest) {
    return { ok: false, error: '未获取到最新版本号，请先点击「检查更新」后再升级' }
  }
  // npm 用精确版本强制升级；GitHub 重放原 spec（其余来源已在上方拒绝）
  const spec = isGithubRef ? p.version : target + '@' + latest

  pluginOpBusy = true
  try {
    const snap = await backupManager.autoSnapshot('plugin-upgrade:' + target)
    if (!snap) return { ok: false, error: '操作前自动备份失败，已中止' }
    logger.info('upgrading plugin', { pkg: target, spec })
    const r = await dshManager.execDsh(['plugin', '--profile', 'web', 'add', spec])
    const output = (r.stdout + '\n' + r.stderr).trim()
    if (r.code === 0) {
      return { ok: true, output }
    }
    return { ok: false, error: '升级失败（exit ' + r.code + '）', output: output.slice(0, 2000) }
  } finally {
    pluginOpBusy = false
  }
}

/**
 * 内置默认插件预置（§4.3.3 扩展）：新装即默认启用
 * - 在 DSH 服务就绪（web profile 已由内核初始化）后调用，幂等：
 *   profile 缺少依赖或缺少 bundles 注册时自动 `dsh plugin add`（装完自动注册进
 *   dsh.profile.bundles = 默认启用，仅需一次重启加载）。
 * - 只执行一次：成功后写 config.defaultPluginsProvisioned 标记；之后即使手动卸载
 *   也不再补装，尊重用户选择。
 */
const DEFAULT_PLUGINS = RECOMMENDED_PLUGINS.filter((p) => p.defaultEnabled)

export async function provisionDefaultPlugins(): Promise<void> {
  try {
    const cfg = configStore.get()
    if (cfg.defaultPluginsProvisioned || DEFAULT_PLUGINS.length === 0) return

    // profile 未初始化前（首次 dsh 启动之前）跳过，等下次服务就绪再预置
    let manifest: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } = {}
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(profileDir(), 'package.json'), 'utf-8'))
    } catch {
      return
    }

    const deps = manifest.dependencies ?? {}
    const bundles = manifest.dsh?.profile?.bundles ?? []
    for (const p of DEFAULT_PLUGINS) {
      // 已安装且已注册进 bundles（默认启用）→ 无需处理
      if (deps[p.name] !== undefined && bundles.includes(p.name)) continue
      logger.info('provisioning default plugin', { name: p.name, installTarget: p.installTarget })
      const r = await installPlugin(p.installTarget)
      if (!r.ok) {
        logger.warn('default plugin provisioning failed', { name: p.name, error: r.error })
        return // 失败不落标记，下次服务就绪自动重试
      }
    }
    configStore.set({ defaultPluginsProvisioned: true })
    logger.info('default plugins provisioned', { names: DEFAULT_PLUGINS.map((p) => p.name) })
  } catch (err) {
    logger.warn('default plugin provisioning error', err instanceof Error ? err.message : String(err))
  }
}
