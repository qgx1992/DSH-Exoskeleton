// 校验 beta 产物内的 zstd-worker 与通知链路确实含本轮改动：
//  - worker（extraResources，不在 asar 内）：turnQuestions 提取 + 注入过滤 + headInfo 渐进扩读
//  - 主进程（asar）：正文含「本次：」、聚合取最后一轮提问
const fs = require('fs')
const path = require('path')
const asar = require('@electron/asar')

let ok = true
const check = (label, cond, extra) => {
  if (!cond) ok = false
  console.log(cond ? '✓' : '✗', label, extra !== undefined ? '= ' + extra : '')
}

// 1) zstd-worker.cjs（extraResources → resources/zstd-worker.cjs）
const wPath = path.join('dist', 'win-unpacked', 'resources', 'zstd-worker.cjs')
const w = fs.readFileSync(wPath, 'utf8')
console.log('--- resources/zstd-worker.cjs (' + (w.length / 1024).toFixed(1) + 'KB) ---')
check('含 turnQuestions 输出', w.includes('turnQuestions: [...turnQuestions.entries()]'))
check('含本轮提问关联（curTurn 切换）', w.includes('curTurn = ev.turn'))
check('含系统注入过滤白名单', w.includes('INJECTED_USER_RE') && w.includes('Current runtime context'))
check('headInfo 渐进扩读（不再固定 512KB 单次）', w.includes('headLen *= 4'))
check('headInfo 有读取封顶', w.includes('HEAD_SCAN_MAX'))
check('headInfo 取末条 session/title', w.includes('lastTitle') && w.includes('winTitle'))
check('已移除「首个 title 即定」旧逻辑', !w.includes("title-llm-request') && !title"))

// 2) 主进程 bundle（asar）
const s = asar.extractFile(path.join('dist', 'win-unpacked', 'resources', 'app.asar'), path.join('out', 'main', 'index.js')).toString('utf8')
console.log('\n--- app.asar out/main/index.js (' + (s.length / 1024).toFixed(1) + 'KB) ---')
check('完成通知正文含「本次：」', s.includes('本次：'))
check('聚合取最后一轮提问（turnQuestion）', s.includes('lastQuestion'))
check('toast 正文换行用 &#10; 实体', s.includes('&#10;'))
check('标题用 notificationTitle（项目名入标题行）', s.includes('notificationTitle'))
check('无旧「项目「」前缀（应为 false）', !s.includes('项目「'), !s.includes('项目「'))

console.log(ok ? '\n结论: 产物含本轮全部改动 ✓' : '\n结论: 产物缺少部分改动 ✗')
process.exit(ok ? 0 : 1)
