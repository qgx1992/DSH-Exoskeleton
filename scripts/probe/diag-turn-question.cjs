// 验证「本轮提问」关联算法：对每个 turn/end，找出该轮 turn/start 之后的第一条真实用户消息。
// 用真实会话数据跑，人工核对结果是否正确（过滤系统注入）。
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function scanFrames(buffer) {
  const frames = []
  let o = 0
  while (o < buffer.length) {
    const start = o
    if (buffer.length - o < 4) return frames
    if (buffer.readUInt32LE(o) !== 4247762216) return frames
    o += 4
    if (o === buffer.length) return frames
    const d = buffer.readUInt8(o); o += 1
    if ((d & 24) !== 0) return frames
    const csf = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3
    const db = df === 3 ? 4 : df, csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf
    o += (ss ? 0 : 1) + db + csb
    for (;;) {
      if (buffer.length - o < 3) return frames
      const bh = buffer.readUIntLE(o, 3); o += 3
      const last = bh & 1, bt = (bh >>> 1) & 3, bs = bh >>> 3
      if (bt === 3) return frames
      o += bt === 1 ? 1 : bs
      if (last) break
    }
    if (ck) o += 4
    frames.push({ start, end: o })
  }
  return frames
}

const INJECTED = /^(?:Current runtime context\.|<system-reminder>|\[genui-action\]|\[model changed|\[Suggestion mode|The user (?:approved|invoked|interrupted)|background job )/
function userText(j) {
  const c = j && j.data && j.data.content
  if (!Array.isArray(c)) return ''
  for (const p of c) if (p && typeof p.text === 'string' && p.text.trim()) return p.text.trim()
  return ''
}

const root = 'C:/Users/qq817/.dsh/sessions'
const targets = []
for (const ws of fs.readdirSync(root)) {
  const wd = path.join(root, ws)
  if (!fs.statSync(wd).isDirectory()) continue
  for (const s of fs.readdirSync(wd)) {
    if (!s.startsWith('session-')) continue
    const sd = path.join(wd, s)
    if (!fs.statSync(sd).isDirectory()) continue
    const f = path.join(sd, 'session.v3.jsonl.zstd')
    if (fs.existsSync(f)) targets.push({ f, uuid: s.replace(/^session-/, '').slice(0, 8) })
  }
}

let totalTurns = 0, matched = 0, injectedOnly = 0
const samples = []
for (const t of targets) {
  const buf = fs.readFileSync(t.f)
  const evs = []
  for (const fr of scanFrames(buf)) {
    let txt = ''
    try { txt = zlib.zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8') } catch { continue }
    for (const l of txt.split('\n')) {
      if (!l.trim()) continue
      try { evs.push(JSON.parse(l)) } catch {}
    }
  }
  evs.sort((a, b) => (a.seq || 0) - (b.seq || 0))

  // 模拟：跟踪 currentTurn，第一条非注入 user 消息作为该轮提问
  let curTurn = null
  const ask = new Map()
  for (const j of evs) {
    if (j.type === 'turn/start' && j.data && typeof j.data.turn === 'number') curTurn = j.data.turn
    else if (j.type === 'user/message') {
      const tx = userText(j)
      if (!tx || curTurn === null) continue
      if (INJECTED.test(tx)) continue
      if (!ask.has(curTurn)) ask.set(curTurn, tx.replace(/\s+/g, ' '))
    } else if (j.type === 'turn/end') {
      const kind = j.data && j.data.reason && j.data.reason.kind
      if (kind !== 'completed') continue
      const turn = j.data && j.data.turn
      totalTurns++
      if (ask.has(turn)) { matched++; if (samples.length < 12) samples.push({ uuid: t.uuid, turn, q: ask.get(turn).slice(0, 62) }) }
      else injectedOnly++
    }
  }
}

console.log('真实会话文件:', targets.length)
console.log('已完成轮次总数:', totalTurns)
console.log('  能关联到「本轮提问」:', matched, '(' + ((matched / totalTurns) * 100).toFixed(1) + '%)')
console.log('  关联不到:', injectedOnly)
console.log('\n=== 样本（会话/轮次 → 识别出的本轮提问）===')
for (const s of samples) console.log('  [' + s.uuid + '] 第' + s.turn + '轮 → ' + s.q)
