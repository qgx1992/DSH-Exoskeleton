#!/usr/bin/env node
/**
 * 生成 Release 中文更新日志：git log <prevTag>..<tag> 按 conventional commit 前缀分组。
 * 供发布流程使用（AGENT.md §0/§7）：在 `npm run dist -- --publish always` 后把生成的
 * markdown 附到 GitHub Release（gh release edit vX.Y.Z --notes-file <out>）。
 *
 * 用法：
 *   node scripts/release-notes.mjs                    # 默认生成最高版本 tag 的日志
 *   node scripts/release-notes.mjs v0.7.4             # 指定 tag
 *   node scripts/release-notes.mjs v0.7.4 --out out/release-notes.md   # 指定输出文件
 *   未指定 --out 时输出到 stdout。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 分组顺序与映射（conventional commit 前缀 → 中文标题 + emoji） */
const GROUPS = [
  { prefix: 'feat', title: '✨ 新功能' },
  { prefix: 'fix', title: '🐛 Bug 修复' },
  { prefix: 'perf', title: '⚡ 性能优化' },
  { prefix: 'refactor', title: '🔧 重构' },
  { prefix: 'docs', title: '📝 文档' },
  { prefix: 'test', title: '✅ 测试' },
  { prefix: 'chore', title: '🧹 维护' }
]

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** desc 排序的版本 tag 列表（只保留标准 vX.Y.Z） */
function versionTags() {
  return sh('git', ['tag', '--sort=-version:refname'])
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
}

/** 取目标 tag 前一级版本 tag；没有则回溯到首个提交 */
function prevTag(tags, target) {
  const idx = tags.indexOf(target)
  if (idx === -1) throw new Error(`未找到 tag ${target}`)
  if (idx + 1 < tags.length) return tags[idx + 1]
  const root = sh('git', ['rev-list', '--max-parents=0', 'HEAD']).trim().split(/\r?\n/)[0]
  return root || undefined
}

function parseArgv(argv) {
  const out = { tag: '', file: '' }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--out') {
      out.file = argv[i + 1]
      i += 2
    } else if (/^v\d+\.\d+\.\d+$/.test(a)) {
      out.tag = a
      i++
    } else {
      i++
    }
  }
  return out
}

function main() {
  const { tag, file } = parseArgv(process.argv.slice(2))
  const tags = versionTags()
  const target = tag || tags[0]
  if (!target) throw new Error('未找到任何版本 tag，无法生成日志')
  const prev = prevTag(tags, target)
  const ver = target.replace(/^v/, '')

  // git log %s（主题行）+ %h，排除 release chore 提交
  const log = sh(
    'git',
    prev
      ? ['log', '--format=%h|%s', `${prev}..${target}`]
      : ['log', '--format=%h|%s', target]
  )
  const rows = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('|')
      return { hash: l.slice(0, i), subject: l.slice(i + 1) }
    })
    .filter((r) => !/^chore: release v/i.test(r.subject))

  const buckets = new Map(GROUPS.map((g) => [g.prefix, []]))
  const other = []
  for (const r of rows) {
    const m = /^([a-z]+)(?:\(.+\))?:\s?(.*)$/i.exec(r.subject)
    if (m && buckets.has(m[1]) && m[2]) {
      buckets.get(m[1]).push(m[2].replace(/[ \t]+$/, ''))
    } else {
      other.push(r.subject)
    }
  }

  const lines = [`## v${ver} 更新日志`, '']
  for (const g of GROUPS) {
    const items = buckets.get(g.prefix)
    if (!items.length) continue
    lines.push(`### ${g.title}`, '')
    for (const it of items) lines.push(`- ${it}`)
    lines.push('')
  }
  if (other.length) {
    lines.push('### 📝 其他', '')
    for (const it of other) lines.push(`- ${it}`)
    lines.push('')
  }
  if (rows.length === 0) {
    lines.push('（本版本无功能/修复可见变更）', '')
  }
  lines.push(`_由脚本生成：${prev ? `${prev}..${target}` : target}_`, '')

  const md = lines.join('\n')
  if (file) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    fs.writeFileSync(file, md, 'utf-8')
    console.log(`更新日志已写入 ${file}`)
  } else {
    process.stdout.write(md)
  }
}

main()