// 取证：一个会话里 session/title 事件的完整情况——
// 有几个、分别是什么、出现在第几帧/第几条、哪个才是 UI 显示的「会话名」。
// 同时对比 headInfo 当前取到的值（它用 if(!title) 取第一个）。
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function scanFrames(b) {
  const f = []
  let o = 0
  while (o < b.length) {
    const s = o
    if (b.length - o < 4) return f
    if (b.readUInt32LE(o) !== 4247762216) return f
    o += 4
    if (o === b.length) return f
    const d = b.readUInt8(o); o += 1
    if ((d & 24) !== 0) return f
    const csf = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3
    const db = df === 3 ? 4 : df, csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf
    o += (ss ? 0 : 1) + db + csb
    for (;;) {
      if (b.length - o < 3) return f
      const bh = b.readUIntLE(o, 3); o += 3
      const last = bh & 1, bt = (bh >>> 1) & 3, bs = bh >>> 3
      if (bt === 3) return f
      o += bt === 1 ? 1 : bs
      if (last) break
    }
    if (ck) o += 4
    f.push({ start: s, end: o })
  }
  return f
}

const root = 'C:/Users/qq817/.dsh/sessions'
const rows = []
for (const ws of fs.readdirSync(root)) {
  const wd = path.join(root, ws)
  if (!fs.statSync(wd).isDirectory()) continue
  for (const s of fs.readdirSync(wd)) {
    if (!s.startsWith('session-')) continue
    const sd = path.join(wd, s)
    if (!fs.statSync(sd).isDirectory()) continue
    const f = path.join(sd, 'session.v3.jsonl.zstd')
    if (!fs.existsSync(f)) continue

    const buf = fs.readFileSync(f)
    const frames = scanFrames(buf)
    const titles = []      // { seq, frame, title, type }
    const users = []
    for (let fi = 0; fi < frames.length; fi++) {
      const fr = frames[fi]
      let t = ''
      try { t = zlib.zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8') } catch { continue }
      for (const l of t.split('\n')) {
        if (!l.trim()) continue
        let j
        try { j = JSON.parse(l) } catch { continue }
        if (j.type === 'session/title' || j.type === 'session/title-llm-request') {
          titles.push({ seq: j.seq, frame: fi, type: j.type, title: j.data && j.data.title })
        }
        if (j.type === 'user/message' && j.data && Array.isArray(j.data.content)) {
          for (const p of j.data.content) {
            if (p && typeof p.text === 'string' && p.text.trim()) { users.push(p.text.trim().slice(0, 70)); break }
          }
        }
      }
    }
    if (titles.length === 0) continue
    rows.push({ uuid: s.replace(/^session-/, '').slice(0, 8), titles, firstUser: users[0] || '', frames: frames.length, size: buf.length })
  }
}

// 统计 title 事件个数分布
const dist = {}
for (const r of rows) dist[r.titles.length] = (dist[r.titles.length] || 0) + 1
console.log('会话数（有 title 事件）:', rows.length)
console.log('每个会话的 title 事件个数分布:', JSON.stringify(dist))

console.log('\n=== 有多个 title 的样本（看第一个 vs 最后一个）===')
const multi = rows.filter((r) => r.titles.length >= 2).slice(0, 10)
for (const r of multi) {
  console.log('\n[' + r.uuid + ']  ' + r.titles.length + ' 个 title 事件')
  console.log('  首条用户消息     : ' + r.firstUser)
  r.titles.forEach((t, i) => {
    console.log('  title[' + i + '] ' + t.type.padEnd(24) + ' seq=' + String(t.seq).padStart(5) + ' 帧' + String(t.frame).padStart(4) + ' → ' + JSON.stringify(t.title))
  })
}

console.log('\n=== 关键统计 ===')
let firstEqUser = 0, lastNeUser = 0, differ = 0
for (const r of rows) {
  const first = r.titles[0].title
  const last = r.titles[r.titles.length - 1].title
  if (first && r.firstUser && first.slice(0, 25) === r.firstUser.slice(0, 25)) firstEqUser++
  if (first !== last) differ++
  if (r.firstUser && last && last.slice(0, 25) !== r.firstUser.slice(0, 25)) lastNeUser++
}
console.log('第一个 title 与首条用户消息相同/前缀一致:', firstEqUser, '/', rows.length)
console.log('最后一个 title 与首条用户消息不同（= 被 AI 重命名过）:', lastNeUser, '/', rows.length)
console.log('第一个 title ≠ 最后一个 title:', differ, '/', rows.length)
