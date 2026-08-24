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
    const res = await fetch(GITHUB_SEARCH, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop' } })
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
    const res = await fetch(NPM_SEARCH)
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

/** 安装插件：自动备份 → 冲突预检 → dsh plugin add */
export async function installPlugin(pkg: string): Promise<PluginActionResult> {
  const target = (pkg ?? '').trim()
  if (!target) return { ok: false, error: '包名不能为空' }
  const installed = listInstalled()
  const conflict = conflictCheck(target, installed)
  if (conflict) return { ok: false, error: conflict }

  await backupManager.autoSnapshot(`plugin-install:${target}`)
  logger.info('installing plugin', { pkg: target })
  const r = await dshManager.execDsh(['plugin', '--profile', 'web', 'add', target])
  const output = `${r.stdout}\n${r.stderr}`.trim()
  if (r.code === 0) {
    return { ok: true, output }
  }
  return { ok: false, error: `安装失败（exit ${r.code}）`, output: output.slice(0, 2000) }
}

/** 卸载插件 */
export async function uninstallPlugin(pkg: string): Promise<PluginActionResult> {
  const target = (pkg ?? '').trim()
  if (!target) return { ok: false, error: '包名不能为空' }
  const installed = listInstalled()
  if (!installed.some((i) => i.name === target)) {
    return { ok: false, error: `插件「${target}」不在当前 profile 依赖中` }
  }

  await backupManager.autoSnapshot(`plugin-uninstall:${target}`)
  logger.info('uninstalling plugin', { pkg: target })
  const r = await dshManager.execDsh(['plugin', '--profile', 'web', 'remove', target])
  const output = `${r.stdout}\n${r.stderr}`.trim()
  if (r.code === 0) {
    return { ok: true, output }
  }
  return { ok: false, error: `卸载失败（exit ${r.code}）`, output: output.slice(0, 2000) }
}