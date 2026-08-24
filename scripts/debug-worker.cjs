// 调试 zstd-worker frameEvents：构造两帧文件 → 调 worker → 打印响应
const { spawn } = require('child_process')
const zlib = require('node:zlib')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = path.join(os.tmpdir(), 'zstd-worker-debug2')
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, 's.jsonl.zstd')

const f1 = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', cwd: 'D:\\p' }) + '\n'))
fs.writeFileSync(file, f1)
const f2 = zlib.zstdCompressSync(
  Buffer.from(
    [
      { type: 'user/message', seq: 1 },
      { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } }
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n'
  )
)
fs.appendFileSync(file, f2)
console.log('f1 len:', f1.length, 'total:', fs.statSync(file).size)

const worker = spawn('node', [path.join(__dirname, 'zstd-worker.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
let out = ''
let count = 0
worker.stdout.on('data', (c) => {
  out += c.toString()
  let idx
  while ((idx = out.indexOf('\n')) >= 0) {
    const line = out.slice(0, idx).trim()
    out = out.slice(idx + 1)
    if (!line) continue
    count++
    console.log('worker 响应[' + count + ']:', line)
    if (count >= 2) {
      worker.kill()
      process.exit(0)
    }
  }
})
worker.stdin.write(JSON.stringify({ cmd: 'init', id: 0 }) + '\n')
setTimeout(() => {
  worker.stdin.write(JSON.stringify({ cmd: 'frameEvents', file, offset: f1.length, id: 1 }) + '\n')
}, 300)
setTimeout(() => { console.error('timeout'); worker.kill(); process.exit(1) }, 5000)