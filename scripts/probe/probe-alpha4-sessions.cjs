// 兼容性回归探针：用壳的生产 zstd-worker 解析 alpha.4 写出的真实会话文件。
// 运行：node scripts/probe/probe-alpha4-sessions.cjs
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const worker = spawn('node', [path.resolve(__dirname, '..', 'zstd-worker.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const pending = new Map()
let seqId = 0
worker.stdout.on('data', (c) => {
  buf += c.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line)
      const p = pending.get(m.id)
      if (p) { pending.delete(m.id); p(m) }
    } catch { /* noop */ }
  }
})
function req(cmd, payload) {
  return new Promise((res) => {
    const id = seqId++
    pending.set(id, res)
    worker.stdin.write(JSON.stringify({ ...payload, cmd, id }) + '\n')
  })
}

function walk(dir, out) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name === 'session.jsonl.zstd') out.push(p)
  }
}

;(async () => {
  const init = await req('init', {})
  console.log('worker init:', JSON.stringify(init))

  const cutoff = new Date('2026-09-01T17:57:00') // alpha.4 安装时刻
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  const all = []
  walk(root, all)
  const files = all
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .filter((x) => x.m >= cutoff.getTime())
    .sort((a, b) => b.m - a.m)
    .slice(0, 12)
  console.log('解析 alpha.4 真实会话文件数:', files.length)

  let okHead = 0, okEvents = 0, turnEnds = 0, askCalls = 0, askAnswered = 0
  let seqMax = 0, timeMin = Infinity, timeMax = 0
  const fails = []
  for (const { f } of files) {
    const head = await req('headInfo', { file: f })
    if (head.ok && (head.title || head.cwd)) okHead++
    else fails.push('headInfo: ' + path.basename(path.dirname(f)) + ' → ' + JSON.stringify(head))
    const fe = await req('frameEvents', { file: f, offset: 0 })
    if (fe.ok) {
      okEvents++
      turnEnds += (fe.turnEnds || []).length
      const evs = fe.events || []
      const asks = evs.filter((e) => e.type === 'tool/call' && e.name === 'ask_user_question')
      askCalls += asks.length
      const res = evs.filter((e) => e.type === 'tool/result' && e.callId)
      askAnswered += asks.filter((a) => res.some((r) => r.callId === a.callId)).length
      for (const e of evs) {
        if (e.seq > seqMax) seqMax = e.seq
        if (e.time) { if (e.time < timeMin) timeMin = e.time; if (e.time > timeMax) timeMax = e.time }
      }
    } else fails.push('frameEvents: ' + path.basename(path.dirname(f)) + ' → ' + fe.error)
  }
  console.log('headInfo 成功:', okHead + '/' + files.length, '| frameEvents 成功:', okEvents + '/' + files.length)
  console.log('turn/end 总数:', turnEnds, '| ask_user_question:', askCalls, '(已配对:', askAnswered + ')')
  console.log('事件 seq 范围: 0..' + seqMax, '| 时间戳范围:', Number.isFinite(timeMin) ? new Date(timeMin).toISOString() + ' ~ ' + new Date(timeMax).toISOString() : '无')
  console.log('失败:', fails.length ? '\n  ' + fails.join('\n  ') : '无')
  worker.stdin.end()
  worker.kill()
  process.exit(fails.length ? 1 : 0)
})()
