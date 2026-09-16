// 量化：要取「最后一个 session/title」需要读多少字节？
// 统计各会话最后 title 事件的字节偏移 vs 文件大小，用于决定 headInfo 的读取策略。
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
    let lastTitleEnd = -1, firstTitleEnd = -1, n = 0
    for (const fr of frames) {
      let t = ''
      try { t = zlib.zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8') } catch { continue }
      if (t.includes('"session/title"')) {
        n++
        if (firstTitleEnd < 0) firstTitleEnd = fr.end
        lastTitleEnd = fr.end
      }
    }
    if (n === 0) continue
    rows.push({ size: buf.length, firstTitleEnd, lastTitleEnd, n })
  }
}

rows.sort((a, b) => b.size - a.size)
console.log('会话数:', rows.length)
console.log('\n按文件大小降序（前 12）：')
console.log('  文件大小      最后title结束于  占比     title事件数')
for (const r of rows.slice(0, 12)) {
  console.log(
    '  ' + (r.size / 1024 / 1024).toFixed(2).padStart(8) + 'MB' +
    (r.lastTitleEnd / 1024 / 1024).toFixed(2).padStart(14) + 'MB' +
    ((r.lastTitleEnd / r.size) * 100).toFixed(1).padStart(8) + '%' +
    String(r.n).padStart(12)
  )
}

const over = (mb) => rows.filter((r) => r.lastTitleEnd > mb * 1024 * 1024).length
console.log('\n最后 title 落在以下字节数之外的会话数：')
for (const mb of [0.5, 1, 2, 4, 8, 16, 32]) {
  console.log('  > ' + String(mb).padStart(2) + 'MB : ' + String(over(mb)).padStart(3) + ' / ' + rows.length)
}
const maxRatio = Math.max(...rows.map((r) => r.lastTitleEnd / r.size))
console.log('\n最后 title 位置占文件比例最大值: ' + (maxRatio * 100).toFixed(1) + '%')
const avg = rows.reduce((a, r) => a + r.size, 0) / rows.length
console.log('平均文件大小: ' + (avg / 1024 / 1024).toFixed(2) + 'MB')
