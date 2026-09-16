// 校验 beta 产物内确实含本次「通知文案」修改（项目名移入标题行）：
// AGENT.md §7 记过「源码改了但产物是旧的」的假通过，故构建后必跑。
const asar = require('@electron/asar')
const path = require('path')
const p = path.join('dist', 'win-unpacked', 'resources', 'app.asar')
const s = asar.extractFile(p, path.join('out', 'main', 'index.js')).toString('utf8')

// 产物里的中文是 UTF-8，直接按字符串匹配
const checks = {
  '通知标题含项目名前缀分隔符（" · "）': s.includes(' · '),
  '完成通知基础标题「DSH 对话完成」': s.includes('DSH 对话完成'),
  '询问通知基础标题「DSH 等待你的回答」': s.includes('DSH 等待你的回答'),
  '聚合正文「已完成 N 轮」': s.includes('（已完成 '),
  '已被移除的旧前缀「项目「」不应存在（应为 false）': s.includes('项目「')
}
let ok = true
for (const [k, v] of Object.entries(checks)) {
  const good = k.includes('应为 false') ? !v : v
  if (!good) ok = false
  console.log(good ? '✓' : '✗', k, '=', v)
}

// 反查实际拼装片段，人工可核
const idx = s.indexOf('DSH 对话完成')
console.log('\n产物内该处上下文:')
console.log('  ...' + s.slice(Math.max(0, idx - 90), idx + 30).replace(/\n/g, '\\n') + '...')
console.log(ok ? '\n结论: 产物含本次文案修改 ✓' : '\n结论: 产物缺少本次文案修改 ✗')
process.exit(ok ? 0 : 1)
