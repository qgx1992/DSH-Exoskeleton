#!/usr/bin/env node
/**
 * dist/ 产物清理：只保留最近 N 个版本（默认 10）的打包产物，其余删除。
 * - 识别 DSH-Exoskeleton-Setup-<ver>.exe / .exe.blockmap 与 DSH-Exoskeleton-Portable-<ver>.exe
 *   （孤儿 blockmap 如仅有 .blockmap 无 exe 的旧版本，同样按版本纳入清理）
 * - 版本按 semver 数值排序（major.minor.patch），取前 KEEP 个版本的全部文件
 * - win-unpacked/、latest.yml 等非版本化产物不动（win-unpacked 每次构建被覆盖）
 * - 用法：node scripts/prune-dist.mjs [--keep N] [--dry-run]
 * - dist/ 本身在 .gitignore 内，本脚本纯本机保洁，发布验证前记得先跑或保留当前版本
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

const argv = process.argv.slice(2)
const keepIdx = argv.indexOf('--keep')
const KEEP = keepIdx >= 0 ? parseInt(argv[keepIdx + 1], 10) : 10
const DRY = argv.includes('--dry-run')

const FILE_RE = /^DSH-Exoskeleton-(?:Setup|Portable)-(\d+\.\d+\.\d+)\.exe(?:\.blockmap)?$/

function cmpVer(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

if (!fs.existsSync(DIST)) {
  console.log('dist/ 不存在，无需清理')
  process.exit(0)
}

const byVersion = new Map()
const otherFiles = []
for (const name of fs.readdirSync(DIST)) {
  const m = FILE_RE.exec(name)
  if (!m) { otherFiles.push(name); continue }
  const ver = m[1]
  if (!byVersion.has(ver)) byVersion.set(ver, [])
  byVersion.get(ver).push(name)
}

const versions = [...byVersion.keys()].sort(cmpVer).reverse()
const keep = versions.slice(0, KEEP)
const prune = versions.slice(KEEP)

console.log(`保留最近 ${KEEP} 个版本: ${keep.join(', ')}`)
if (prune.length === 0) {
  console.log('无需清理')
  process.exit(0)
}

let freed = 0
let removed = 0
for (const ver of prune) {
  for (const name of byVersion.get(ver)) {
    const fp = path.join(DIST, name)
    const size = fs.statSync(fp).size
    freed += size
    removed++
    console.log(`  [删] ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
    if (!DRY) fs.rmSync(fp)
  }
}
console.log(`${DRY ? '（dry-run，未实际删除）' : ''}共 ${removed} 个文件 / ${prune.length} 个旧版本，释放 ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB`)
console.log('dist/ 其余非版本化文件保留:', otherFiles.join(', '))
