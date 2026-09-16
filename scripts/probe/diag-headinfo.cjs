// 取证：真实会话上 headInfo 的成功率（标题/cwd/首条用户消息是否拿得到）
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = 'C:/Users/qq817/.dsh/sessions'
const files = []
for (const ws of fs.readdirSync(root)) {
  const wd = path.join(root, ws)
  if (!fs.statSync(wd).isDirectory()) continue
  for (const s of fs.readdirSync(wd)) {
    if (!s.startsWith('session-')) continue
    const sd = path.join(wd, s)
    if (!fs.statSync(sd).isDirectory()) continue
    for (const fn of ['session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
      const f = path.join(sd, fn)
      if (fs.existsSync(f)) files.push({ f, size: fs.statSync(f).size, fn })
    }
  }
}

const c = spawn('node', [path.resolve('scripts/zstd-worker.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
const res = new Map()
let buf = ''
c.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try { const j = JSON.parse(line); res.set(j.id, j) } catch {}
  }
})

files.forEach((x, id) => c.stdin.write(JSON.stringify({ cmd: 'headInfo', file: x.f, id }) + '\n'))

setTimeout(() => {
  c.kill()
  let noCwd = 0, noTitle = 0, noFirst = 0, full = 0, timeout = 0
  const emptyTitleSamples = []
  files.forEach((x, id) => {
    const r = res.get(id)
    if (!r || !r.ok) { timeout++; return }
    if (!r.cwd) noCwd++
    if (!r.title) { noTitle++; if (emptyTitleSamples.length < 6) emptyTitleSamples.push(x) }
    if (!r.firstUserText) noFirst++
    if (r.cwd && r.title && r.firstUserText) full++
  })
  console.log('真实会话文件总数:', files.length)
  console.log('  三项齐全      :', full)
  console.log('  无 cwd        :', noCwd)
  console.log('  title 为空    :', noTitle)
  console.log('  firstUser 为空:', noFirst)
  console.log('  未响应/失败   :', timeout)
  console.log('\ntitle 为空的样本（文件名 + 大小）:')
  for (const s of emptyTitleSamples) console.log('  ', s.fn, (s.size / 1024).toFixed(0) + 'KB', s.f.replace(root, ''))
}, 12000)
