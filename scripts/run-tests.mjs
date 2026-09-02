#!/usr/bin/env node
/**
 * 主进程模块冒烟测试 runner（替代原 package.json 里 20+ 段 && 串跑的一行链）。
 * - 每个用例声明：bundle 源 → 产物名 → 测试脚本；统一 esbuild --platform=node --format=cjs
 * - 失败时报出「用例名 + 失败阶段（bundle/run）+ 退出码」，不再需要人肉数 && 断在哪
 * - 用法：npm test（可从任意 cwd 运行，路径均相对仓库根）
 * 新增用例只需往 CASES 数组加一行。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'package.json'))
const electronBin = require('electron') // electron 包导出即二进制路径
const esbuildBin = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')

/** 用例表：{ name, src（bundle 入口）, out（scripts/out 产物名）, test（runner 脚本）, externals?, plain?（不 bundle 直接 node 跑） } */
const CASES = [
  { name: 'credentials', plain: ['--experimental-strip-types', 'scripts/test/test-credentials.ts'] },
  { name: 'backup', src: 'src/main/backup.ts', out: 'backup.cjs', test: 'scripts/test/test-backup.cjs' },
  { name: 'kernel-manager', src: 'src/main/kernel-manager.ts', out: 'kernel-manager.cjs', test: 'scripts/test/test-kernel.cjs', externals: ['@deepseek-ai/*'] },
  { name: 'kernel-compat', src: 'src/main/kernel-compat.ts', out: 'kernel-compat.cjs', test: 'scripts/test/test-kernel-compat.cjs', externals: ['@deepseek-ai/*'] },
  { name: 'kernel-provision', src: 'scripts/test/test-kernel-provision-entry.ts', out: 'kernel-provision.cjs', test: 'scripts/test/test-kernel-provision.cjs', externals: ['@deepseek-ai/*'] },
  { name: 'profiles', src: 'src/main/profiles.ts', out: 'profiles.cjs', test: 'scripts/test/test-profiles.cjs' },
  { name: 'session-watcher', src: 'src/main/session-watcher.ts', out: 'session-watcher.cjs', test: 'scripts/test/test-session.cjs' },
  { name: 'notification-hub', src: 'scripts/test/test-notify-entry.ts', out: 'notification-hub.cjs', test: 'scripts/test/test-notify.cjs' },
  { name: 'session-ask', src: 'scripts/test/test-ask-entry.ts', out: 'session-ask.cjs', test: 'scripts/test/test-ask-detect.cjs' },
  { name: 'dsh-view-preload', src: 'src/preload/dsh-view.ts', out: 'dsh-view.cjs', test: 'scripts/test/test-dsh-view.cjs' },
  { name: 'session-jsonl', plain: ['--experimental-strip-types', 'scripts/test/test-session-jsonl.mts'] },
]

function run(label, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true })
  if (r.error) {
    console.error(`\n[FAIL] ${label}: 无法启动 ${cmd}: ${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`\n[FAIL] ${label}: 退出码 ${r.status}`)
    process.exit(r.status ?? 1)
  }
}

const only = process.argv[2] // 可选：npm test -- kernel-compat 只跑某用例（按名称子串匹配）
let passed = 0
for (const c of CASES) {
  if (only && !c.name.includes(only)) continue
  if (c.plain) {
    console.log(`\n=== [${c.name}] node ${c.plain.join(' ')}`)
    run(`${c.name}`, process.execPath, c.plain.map(p => (p.startsWith('-') ? p : path.resolve(ROOT, p))))
  } else {
    console.log(`\n=== [${c.name}] bundle ${c.src} -> scripts/out/${c.out}`)
    run(`${c.name} (bundle)`, process.execPath, [
      esbuildBin, c.src,
      '--bundle', '--platform=node',
      '--external:electron',
      ...(c.externals ?? []).map(e => `--external:${e}`),
      '--format=cjs',
      `--outfile=${path.join('scripts', 'out', c.out)}`,
    ])
    console.log(`--- [${c.name}] electron ${c.test}`)
    run(`${c.name} (run)`, electronBin, [path.resolve(ROOT, c.test)])
  }
  passed++
}
console.log(`\nOK: ${passed} 个用例全部通过`)
