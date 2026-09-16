#!/usr/bin/env node
/**
 * dist/ 产物清理：按「正式版 / 预发布版」两条通道分别保留最近 N 个版本。
 *
 * - 识别 DSH-Exoskeleton-Setup-<ver>.exe / .exe.blockmap 与 DSH-Exoskeleton-Portable-<ver>.exe
 *   （孤儿 blockmap 如仅有 .blockmap 无 exe 的旧版本，同样按版本纳入清理）
 * - **两条通道分开计数**（v0.9.4 起）：
 *     · 正式版 `0.9.4`        → 默认保留最近 5 个（`--keep N`）
 *     · 预发布 `0.9.4-beta.4` → 默认保留最近 2 个（`--keep-beta N`）
 *   为什么分开：AGENT.md §0 要求开发期频繁出 beta 自测，而 beta 用完即弃。
 *   旧实现的正则只认 `x.y.z`，`-beta.N` 后缀匹配不上 → beta 产物被归入
 *   「非版本化文件」永久保留，只增不减（实测累积到 1.4GB 才被发现）。
 *   保留数量偏小：正式包已发布到 GitHub Release，本地无需长期存档，
 *   dist/ 只服务于「本机回滚/对照最近几版」的临时需求。
 * - 版本排序绝不比字符串（R-22）：`beta.10` 必须排在 `beta.2` 之后；
 *   正式版高于同 base 的预发布版。比较口径的权威实现在 src/shared/version.ts，
 *   此处是「发行产物文件名」这一窄域下的等价子集（该模块是 TS，.mjs 脚本不便直接引）。
 * - win-unpacked/、latest.yml 等非版本化产物不动（win-unpacked 每次构建被覆盖）
 * - 用法：node scripts/prune-dist.mjs [--keep N] [--keep-beta N] [--dry-run]
 * - dist/ 本身在 .gitignore 内，本脚本纯本机保洁，发布验证前记得先跑或保留当前版本
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

/** 产物文件名 → 版本号（允许 `-beta.4` 等预发布后缀） */
export const FILE_RE = /^DSH-Exoskeleton-(?:Setup|Portable)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)\.exe(?:\.blockmap)?$/

/** 默认保留数量：正式版 / 预发布版（抽成常量便于测试断言，防文档与代码漂移） */
export const DEFAULT_KEEP = 5
export const DEFAULT_KEEP_BETA = 2

/** 是否预发布版（带 `-xxx` 后缀） */
export function isPrerelease(version) {
  return version.includes('-')
}

/** 拆版本号：base 数字段 + 预发布标识串 */
export function parseVersion(version) {
  const [base, ...rest] = version.split('-')
  return { base: base.split('.').map((n) => parseInt(n, 10) || 0), pre: rest.join('-') }
}

/**
 * 版本比较：a>b 返回 1，a<b 返回 -1，相等 0。
 * 规则（与 src/shared/version.ts 一致）：先比 base 数字段；base 相同则正式版 > 预发布版；
 * 预发布之间逐段比较——数字段按数值（beta.10 > beta.2）、数字 < 非数字、段少 < 段多。
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.base.length, pb.base.length)
  for (let i = 0; i < len; i++) {
    const x = pa.base[i] ?? 0
    const y = pb.base[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1 // 正式版 > 预发布版
  if (!pb.pre) return -1
  const aParts = pa.pre.split('.')
  const bParts = pb.pre.split('.')
  const n = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < n; i++) {
    const x = aParts[i]
    const y = bParts[i]
    if (x === y) continue
    if (x === undefined) return -1 // 段少 < 段多（beta < beta.1）
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const xn = parseInt(x, 10)
      const yn = parseInt(y, 10)
      if (xn !== yn) return xn > yn ? 1 : -1
    } else if (xNum) {
      return -1 // 数字标识符 < 字母标识符
    } else if (yNum) {
      return 1
    } else {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * 扫描 dist/，按版本聚合产物文件名。
 * @returns {{ stable: Map<string, string[]>, prerelease: Map<string, string[]>, otherFiles: string[] }}
 */
export function groupDistFiles(names) {
  const stable = new Map()
  const prerelease = new Map()
  const otherFiles = []
  for (const name of names) {
    const m = FILE_RE.exec(name)
    if (!m) {
      otherFiles.push(name)
      continue
    }
    const ver = m[1]
    const bucket = isPrerelease(ver) ? prerelease : stable
    if (!bucket.has(ver)) bucket.set(ver, [])
    bucket.get(ver).push(name)
  }
  return { stable, prerelease, otherFiles }
}

/**
 * 计算某通道要保留/删除哪些版本。
 * @returns {{ keep: string[], prune: string[] }} 均为按版本降序
 */
export function planChannel(versions, keepCount) {
  const sorted = [...versions].sort((a, b) => compareVersions(b, a))
  return { keep: sorted.slice(0, keepCount), prune: sorted.slice(keepCount) }
}

/** 打印一条通道的计划并（非 dry-run 时）执行删除 */
function pruneChannel(label, bucket, keepCount, dryRun) {
  const { keep, prune } = planChannel(bucket.keys(), keepCount)
  if (prune.length === 0) {
    console.log(`${label}：保留 ${keepCount} 个 → 现有 ${keep.length} 个，无需清理`)
    return { removed: 0, freed: 0, versions: 0 }
  }
  console.log(`${label}：保留 ${keepCount} 个 → ${keep.join(', ')}`)
  let freed = 0
  let removed = 0
  for (const ver of prune) {
    for (const name of bucket.get(ver)) {
      const fp = path.join(DIST, name)
      const size = fs.statSync(fp).size
      freed += size
      removed++
      console.log(`  [删] ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
      if (!dryRun) fs.rmSync(fp)
    }
  }
  return { removed, freed, versions: prune.length }
}

function main() {
  const argv = process.argv.slice(2)
  const numArg = (flag, dflt) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? parseInt(argv[i + 1], 10) : dflt
  }
  const KEEP = numArg('--keep', DEFAULT_KEEP)
  const KEEP_BETA = numArg('--keep-beta', DEFAULT_KEEP_BETA)
  const DRY = argv.includes('--dry-run')

  if (!Number.isFinite(KEEP) || !Number.isFinite(KEEP_BETA) || KEEP < 0 || KEEP_BETA < 0) {
    console.error('参数无效：--keep / --keep-beta 需为非负整数')
    process.exit(1)
  }

  if (!fs.existsSync(DIST)) {
    console.log('dist/ 不存在，无需清理')
    process.exit(0)
  }

  const { stable, prerelease, otherFiles } = groupDistFiles(fs.readdirSync(DIST))

  let removed = 0
  let freed = 0
  let versions = 0
  for (const [label, bucket, count] of [
    ['正式版', stable, KEEP],
    ['预发布版', prerelease, KEEP_BETA]
  ]) {
    const r = pruneChannel(label, bucket, count, DRY)
    removed += r.removed
    freed += r.freed
    versions += r.versions
  }

  if (removed === 0) {
    console.log(`\n${DRY ? '（dry-run）' : ''}无需清理`)
  } else {
    console.log(
      `\n${DRY ? '（dry-run，未实际删除）' : ''}共 ${removed} 个文件 / ${versions} 个旧版本，` +
        `释放 ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB`
    )
  }
  console.log('dist/ 其余非版本化文件保留:', otherFiles.join(', '))
}

// 仅在直接执行时跑 main（被测试 import 时不跑）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
