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
import { RECOMMENDED_PLUGINS, type RecommendedPlugin } from '../shared/recommended-plugins'
import { COMPAT_PATCHES } from './kernel-compat'
import type { PluginCatalogItem, InstalledPlugin, PluginActionResult, PluginUpdateInfo, SaveResult } from '../shared/types'

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
  // 当前生效内核的兼容补丁会按 loader 行 id 停用部分插件（如 alpha.2 下的 dshmarket /
  // better-sidebar）：这类“装了但看不到效果”在面板上显式标出，避免用户误判为安装失败。
  const compat = activeCompatDisabledRows()
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    const deps: Record<string, string> = pkg?.dependencies ?? {}
    for (const [name, version] of Object.entries(deps)) {
      let compatDisabled: string | null = null
      if (compat) {
        const hit = pluginEntryRowIds(name).filter((id) => compat.rows.has(id))
        if (hit.length > 0) {
          compatDisabled =
            '当前内核 v' + (configStore.get().defaultKernelVersion ?? '?') + ' 的兼容补丁停用了该插件（entry: ' + hit.join(', ') + '）。' +
            '插件已安装但在本内核下不加载，升级插件适配或换内核后自动恢复。'
        }
      }
      out.push({ name, version: String(version), update: null, compatDisabled })
    }
  } catch (err) {
    logger.warn('read installed plugins failed', err)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 当前生效托管内核的兼容补丁停用行（loader entry id 集合）；
 * 系统 dsh 模式 / 无默认内核 / 该版本无补丁 → null。
 */
function activeCompatDisabledRows(): { rows: Set<string>; note: string } | null {
  try {
    const cfg = configStore.get()
    if (cfg.kernelMode !== 'managed') return null
    const version = cfg.defaultKernelVersion
    if (!version) return null
    const spec = COMPAT_PATCHES[version]
    if (!spec || spec.rows.length === 0) return null
    return { rows: new Set(spec.rows), note: spec.note }
  } catch {
    return null
  }
}

/**
 * 解析插件包自带的 bundle 补丁层（cordis.patch.yml），取它 insert 的 loader 行 id。
 * 形如 `- insert:` 下的 `- id: dsh-market` / `name: 'dshmarket'`。补丁文件很小且形状固定，
 * 正则足够（不为这一个字段引入 YAML 解析依赖）。
 */
function pluginEntryRowIds(name: string): string[] {
  try {
    const file = path.join(nodeModulesDir(), name, 'cordis.patch.yml')
    const text = fs.readFileSync(file, 'utf-8')
    const ids: string[] = []
    for (const m of text.matchAll(/^\s*-?\s*id:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/gm)) {
      const id = m[1]
      if (id && !ids.includes(id)) ids.push(id)
    }
    return ids
  } catch {
    return []
  }
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

/**
 * pnpm 10+/12 供应链策略：未在 allowBuilds 白名单的依赖 build script 被拦截时，
 * pnpm 以 exit 1 + ERR_PNPM_IGNORED_BUILDS 收尾（依赖其实已写入 package.json）。
 * 与内核安装（kernel-manager.isIgnoredBuilds）同语义：原生模块（node-pty 等）由
 * prebuilt 或 fallback build 提供，忽略构建不等于安装失败。
 */
function isIgnoredBuilds(r: { stdout: string; stderr: string }): boolean {
  return /ERR_PNPM_IGNORED_BUILDS|IGNORED_BUILDS/i.test(r.stderr + ' ' + r.stdout)
}

/** 从 IGNORED_BUILDS 报错里解析被拦截的包名（"Ignored build scripts: node-pty@1.1.0, …"） */
function ignoredBuildPackages(r: { stdout: string; stderr: string }): string[] {
  const m = /Ignored build scripts:\s*([^\n]+)/i.exec(r.stderr)
  if (!m) return []
  return m[1]
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      // "@scope/name@version" / "name@version" → 剥掉版本号保留包名
      const scoped = spec.match(/^(@[^@\s]+\/)?([^@\s]+)@[\w.\-+]+$/)
      if (scoped) return (scoped[1] ?? '') + scoped[2]
      // GitHub 等无法识别 spec（github:owner/repo#sha）原样返回；allowBuilds 若匹配不上由
      // isIgnoredBuilds 兜底按成功处理
      return spec
    })
}

/**
 * 把包名设为 profile pnpm-workspace.yaml 的 allowBuilds:true（pnpm 12 构建白名单）。
 * 字符串级编辑（文件小且形状固定，不为白名单维护引入 YAML 解析依赖，风格同 pluginEntryRowIds）。
 * 覆盖三种形态：已有条目（含 pnpm 自动写入的占位 "set this to true or false"）→ 置 true；
 * allowBuilds 块存在缺该包 → 追加行；块不存在 → 末尾新建。
 */
function allowBuild(pkg: string): void {
  try {
    const file = path.join(profileDir(), 'pnpm-workspace.yaml')
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf-8')
    } catch {
      /* 文件不存在时从零创建 */
    }
    const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const entryRe = new RegExp('^(\\s*)' + esc + '\\s*:.*$', 'm')
    if (entryRe.test(text)) {
      text = text.replace(entryRe, '  ' + pkg + ': true')
    } else if (/^allowBuilds:\s*$/m.test(text)) {
      text = text.replace(/^allowBuilds:\s*$/m, 'allowBuilds:\n  ' + pkg + ': true')
    } else {
      const sep = text === '' || text.endsWith('\n') ? '' : '\n'
      text += sep + 'allowBuilds:\n  ' + pkg + ': true\n'
    }
    fs.writeFileSync(file, text, 'utf-8')
    logger.info('allowBuilds updated', { pkg, file })
  } catch (err) {
    logger.warn('allowBuilds update failed', { pkg, err })
  }
}

/**
 * 执行 dsh 插件子命令；遇 ERR_PNPM_IGNORED_BUILDS 时把被拦包写入 allowBuilds 白名单后重试一次。
 * 重试成功后 pnpm 会执行 build script 并以 exit 0 收尾，dsh 的 bundle reconcile 得以正常完成。
 */
async function execDshWithAllowBuilds(
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let r = await dshManager.execDsh(args)
  if (r.code !== 0 && isIgnoredBuilds(r)) {
    const pkgs = ignoredBuildPackages(r)
    logger.info('ignored builds detected, allowing build scripts and retrying', { pkgs })
    for (const p of pkgs) allowBuild(p)
    if (pkgs.length > 0) r = await dshManager.execDsh(args)
  }
  return r
}

/** 已装包是否声明 dsh.bundle（bundle 层插件）；读不到按否 */
function declaresBundle(name: string): boolean {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(nodeModulesDir(), name, 'package.json'), 'utf-8'))
    return !!meta?.dsh?.bundle
  } catch {
    return false
  }
}

/**
 * 修复历史欠账：已安装且声明 dsh.bundle、但未进入 dsh.profile.bundles 的插件补注册。
 * IGNORED_BUILDS 时代 `dsh plugin add` 以 exit 1 收尾，依赖写入了、bundle reconcile 中断，
 * 导致市场把本该是 bundle 层插件的条目显示成「未进入 bundle 层 / 纯客户端」。幂等：
 * 已在 bundles 的跳过；只补不删。服务就绪时调用一次，新安装成功路径也调用。
 */
export function reconcileInstalledBundles(): void {
  try {
    const dir = profileDir()
    const pkgPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgPath)) return
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const deps: Record<string, string> = pkg?.dependencies ?? {}
    const bundles: string[] = pkg?.dsh?.profile?.bundles ?? []
    const missing = Object.keys(deps).filter((name) => !bundles.includes(name) && declaresBundle(name))
    if (missing.length === 0) return
    // R-3: 原子写（临时文件 + rename）
    pkg.dsh = pkg.dsh ?? {}
    pkg.dsh.profile = pkg.dsh.profile ?? {}
    pkg.dsh.profile.bundles = [...bundles, ...missing]
    const tmp = pkgPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
    fs.renameSync(tmp, pkgPath)
    logger.info('reconciled missing bundles', { added: missing })
  } catch (err) {
    logger.warn('reconcile installed bundles failed', err)
  }
}

/**
 * 卸载后清理悬空 bundle 条目：依赖已被 pnpm 移除（deps 无引用）且 node_modules 已不存在的
 * bundles 成员（防下次启动按名加载失败）。内核侧 bundle（@deepseek-ai/dsh-base 等）在
 * profile node_modules 存在 relink 链接，不会被误删。
 */
function pruneDanglingBundleEntries(): void {
  try {
    const dir = profileDir()
    const pkgPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgPath)) return
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const bundles: string[] = pkg?.dsh?.profile?.bundles ?? []
    const deps: Record<string, string> = pkg?.dependencies ?? {}
    const dangling = bundles.filter(
      (b) => deps[b] === undefined && !fs.existsSync(path.join(nodeModulesDir(), b))
    )
    if (dangling.length === 0) return
    pkg.dsh = pkg.dsh ?? {}
    pkg.dsh.profile = pkg.dsh.profile ?? {}
    pkg.dsh.profile.bundles = bundles.filter((b) => !dangling.includes(b))
    const tmp = pkgPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
    fs.renameSync(tmp, pkgPath)
    logger.info('pruned dangling bundle entries', { removed: dangling })
  } catch (err) {
    logger.warn('prune dangling bundle entries failed', err)
  }
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
    // ERR_PNPM_IGNORED_BUILDS：依赖已写入但 dsh 以 exit 1 收尾（reconcile 中断、面板误报失败）。
    // 被拦包先补进 allowBuilds 白名单重试；仍失败时按成功处理并补 bundle 层注册。
    const r = await execDshWithAllowBuilds(['plugin', '--profile', 'web', 'add', target])
    const output = (r.stdout + '\n' + r.stderr).trim()
    if (r.code === 0 || isIgnoredBuilds(r)) {
      // dsh 在 exit 0 时会自己 reconcile 进 bundles（含 allowBuilds 重试成功后）;
      // IGNORED_BUILDS 末端兜底统一补齐，避免市场显示「未进入 bundle 层」
      reconcileInstalledBundles()
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
    const r = await execDshWithAllowBuilds(['plugin', '--profile', 'web', 'remove', target])
    const output = (r.stdout + '\n' + r.stderr).trim()
    if (r.code === 0 || isIgnoredBuilds(r)) {
      // IGNORED_BUILDS 路径 pnpm 已移除依赖但 dsh 可能未清 bundles → 清理悬空条目
      pruneDanglingBundleEntries()
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
    const r = await execDshWithAllowBuilds(['plugin', '--profile', 'web', 'add', spec])
    const output = (r.stdout + '\n' + r.stderr).trim()
    if (r.code === 0 || isIgnoredBuilds(r)) {
      reconcileInstalledBundles()
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

/**
 * 把已安装插件加入「推荐插件」列表（用户自定义推荐，持久化于 config.customRecommendedPlugins）。
 * installTarget 取 profile dependencies 的声明 spec（github: / link: / 版本号），
 * 保证推荐区点「安装」能装回同一来源；内置精选已有同名项时拒绝（避免重复条目）。
 */
export function recommendPlugin(name: string): SaveResult {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return { ok: false, error: '插件名不能为空' }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir(), 'package.json'), 'utf-8'))
    const declared: unknown = manifest?.dependencies?.[trimmed]
    if (typeof declared !== 'string' || !declared) return { ok: false, error: '插件未安装：' + trimmed }
    if (RECOMMENDED_PLUGINS.some((p) => p.name === trimmed)) {
      return { ok: false, error: '该插件已在内置推荐列表中' }
    }
    // 描述/主页尽量从已装包补齐；读不到时用占位（不影响安装）
    let meta: { description?: unknown; homepage?: unknown } = {}
    try {
      meta = JSON.parse(fs.readFileSync(path.join(nodeModulesDir(), trimmed, 'package.json'), 'utf-8'))
    } catch {
      /* noop */
    }
    const src = detectSource(declared)
    const entry: RecommendedPlugin = {
      installTarget: declared,
      name: trimmed,
      description: typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : '已加入推荐的插件',
      source: src === 'github' ? 'github' : src === 'local' ? 'local' : 'npm',
      url: typeof meta.homepage === 'string' ? meta.homepage : ''
    }
    const cfg = configStore.get()
    const list = cfg.customRecommendedPlugins ?? []
    if (list.some((p) => p.name === trimmed)) return { ok: true }
    configStore.set({ customRecommendedPlugins: [...list, entry] })
    logger.info('plugin added to recommendations', { name: trimmed, source: entry.source })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 从推荐列表移除自定义推荐项（内置精选不可移除） */
export function unrecommendPlugin(name: string): SaveResult {
  try {
    const cfg = configStore.get()
    const list = cfg.customRecommendedPlugins ?? []
    const next = list.filter((p) => p.name !== name)
    if (next.length === list.length) return { ok: false, error: '该插件不在自定义推荐列表中' }
    configStore.set({ customRecommendedPlugins: next })
    logger.info('plugin removed from recommendations', { name })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
