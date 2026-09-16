// 校验打包产物内确实含本次修复（AGENT.md 已知坑：源码改了但产物是旧的 → 假通过）
const asar = require('@electron/asar')
const path = require('path')
const p = path.join('dist', 'win-unpacked', 'resources', 'app.asar')
const s = asar.extractFile(p, path.join('out', 'main', 'index.js')).toString('utf8')
console.log('产物主进程 index.js:', (s.length / 1024).toFixed(1), 'KB')

const hits = [...s.matchAll(/session[^"'`\n]{0,45}jsonl[^"'`\n]{0,25}/g)].map((m) => m[0])
console.log('\n产物内的会话日志相关字符串:')
for (const h of [...new Set(hits)]) console.log('  ', JSON.stringify(h))

const checks = {
  '世代择优逻辑 (version > best.version)': s.includes('version > best.version'),
  '文件名代数正则 (.vN 捕获)': s.includes('[1-9][0-9]*)') && s.includes('jsonl'),
  'readdirSync 扫描会话目录': s.includes('readdirSync'),
  '换世代重建基线 (rebaseline)': s.includes('rebaseline'),
  '残留旧名硬编码 (应为 false)': s.includes("'session.jsonl.zstd'") || s.includes('"session.jsonl.zstd"')
}
console.log('')
let ok = true
for (const [k, v] of Object.entries(checks)) {
  const good = k.includes('应为 false') ? !v : v
  if (!good) ok = false
  console.log(good ? '✓' : '✗', k, '=', v)
}
console.log(ok ? '\n结论: 打包产物确实包含本次修复 ✓' : '\n结论: 产物缺少修复 ✗')
process.exit(ok ? 0 : 1)
