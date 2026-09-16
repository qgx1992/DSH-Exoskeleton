// 关键验证：真实场景下 turn/start+提问 与 turn/end 分处不同批次（不同帧）。
// frameEvents 只解析 offset 之后的帧，所以「本轮提问」可能在 turn/end 到达时已读不到。
// 模拟：先写 turn/start+提问（扫描一次），再追加 turn/end（再扫描），看能否拿到提问。
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-inc-'))
const file = path.join(tmp, 's.zstd')
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.map((o) => JSON.stringify(o)).join('\n') + '\n'))

// 第一批：turn/start + 提问
fs.writeFileSync(file, frame([
  { type: 'session', cwd: 'D:\\p', id: 'x' },
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 7 } },
  { type: 'user/message', seq: 2, time: 2, data: { role: 'user', content: [{ type: 'text', text: '把导出改成 CSV' }] } }
]))
const sizeAfterFirst = fs.statSync(file).size

const c = spawn('node', [path.resolve('scripts/zstd-worker.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const got = new Map()
c.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!l.trim()) continue
    try { const j = JSON.parse(l); got.set(j.id, j) } catch {}
  }
})

;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 第一次扫描：从 0 开始（模拟 watcher 首次看到该会话）
  c.stdin.write(JSON.stringify({ cmd: 'frameEvents', file, offset: 0, id: 1 }) + '\n')
  await sleep(500)
  const r1 = got.get(1)
  console.log('第一次扫描（offset=0，含 turn/start+提问）:')
  console.log('  turnQuestions =', JSON.stringify(r1 && r1.turnQuestions))

  // 第二批：追加 turn/end（新一轮数据，watcher 会用 sizeAfterFirst 作为 offset）
  fs.appendFileSync(file, frame([
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 7, reason: { kind: 'completed' } } }
  ]))
  c.stdin.write(JSON.stringify({ cmd: 'frameEvents', file, offset: sizeAfterFirst, id: 2 }) + '\n')
  await sleep(500)
  const r2 = got.get(2)
  console.log('\n第二次扫描（offset=第一批大小，仅含 turn/end）:')
  console.log('  turnQuestions =', JSON.stringify(r2 && r2.turnQuestions))
  console.log('  turnEnds      =', JSON.stringify(r2 && r2.turnEnds))

  const ok = r2 && r2.turnQuestions && r2.turnQuestions.length > 0
  console.log('\n结论: turn/end 到达时' + (ok ? '能' : '不能') + '拿到本轮提问')
  if (!ok) console.log('→ 「本次提问」在真实增量场景下会丢失（测试用例把三者放同一帧，掩盖了这个问题）')
  c.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
})()
