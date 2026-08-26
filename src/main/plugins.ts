/**
 * 插件管理器（文档 §4.3.3）
 * - 目录：GitHub topic:dsh-plugin + npm 搜索（双来源）
 * - 安装/卸载：复用 `dsh plugin --profile web add|remove <pkg>`（转发 pnpm）
 * - 冲突预检：同名已安装先报告
 * - 每次安装/卸载前自动创建备份快照（§4.3.4）
 */
import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import { backupManager } from './backup'
import type { PluginCatalogItem, InstalledPlugin, PluginActionResult } from '../shared/types'

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
      out.push({ name, version: String(version) })
    }
  } catch (err) {
    logger.warn('read installed plugins failed', err)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
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