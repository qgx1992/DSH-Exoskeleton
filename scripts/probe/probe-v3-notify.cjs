// 取证：会话日志已升级为 session.v3.jsonl.zstd（Session format v3），
// 而 session-watcher / sessions.ts 硬编码 session.jsonl.zstd。
// 本探针在同一个假 DSH_HOME 下建两个会话（旧名 / 新名），各自追加一轮 turn/end，
// 断言 watcher 能识别哪个 —— 用于定位「通知失效」根因。
const { app } = require('electron')
const child = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.DSH_SESSION_POLL_MS = '150'

const tmpRoot = path.join(os.tmpdir(), 'dsh-v3-probe-' + Date.now())
const fakeHome = path.join(tmpRoot, 'fake-dsh')
process.env.DSH_HOME = fakeHome
app.setName('DshV3Probe')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nodeExe = (() => {
  try { return child.execFileSync('where', ['node'], { encoding: 'utf-8' }).trim().split(/\r?\n/)[0] } catch { return 'node' }
})()
const zstdFrame = (lines, out) => {
  child.execFileSync(nodeExe, ['-e', `
    const z = require('node:zlib'); const fs = require('fs');
    const objs = JSON.parse(process.argv[1]);
    fs.writeFileSync(process.argv[2], z.zstdCompressSync(Buffer.from(objs.map(o => JSON.stringify(o)).join('\\n') + '\\n')));
  `, JSON.stringify(lines), out])
}

app.whenReady().then(async () => {
  const { sessionWatcher, wireSessionWatcher } = require('../out/session-watcher.cjs')
  wireSessionWatcher()

  const wsName = '--D-probe-ws--'
  const mkSess = (uuid, filename) => {
    const sessDir = path.join(fakeHome, 'sessions', wsName, `session-${uuid}`)
    fs.mkdirSync(sessDir, { recursive: true })
    return { sessDir, jsonl: path.join(sessDir, filename), mid: path.join(sessDir, 'mid-frame.tmp'), uuid }
  }
  const append = (s) => fs.appendFileSync(s.jsonl, fs.readFileSync(s.mid))
  const head = (uuid, cwd) => [
    { type: 'session', cwd, id: `session-${uuid}` },
    { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }
  ]
  const turnEnd = (turn) => [
    { type: 'turn/end', seq: 100 + turn, time: Date.now(), data: { turn, reason: { kind: 'completed' } } }
  ]

  const completed = []
  sessionWatcher.on('complete', (ev) => completed.push(ev))

  // 旧命名（v0 世代）—— 当前代码唯一认得的文件名
  const legacy = mkSess('legacy-0000-4000-8000-000000000001', 'session.jsonl.zstd')
  zstdFrame(head(legacy.uuid, 'D:\\proj\\legacy'), legacy.jsonl)

  // 新命名（Session format v3，内核 0.1.5-rc.2 实际写入的文件名）
  const v3 = mkSess('vthree-0000-4000-8000-000000000002', 'session.v3.jsonl.zstd')
  zstdFrame(head(v3.uuid, 'D:\\proj\\vthree'), v3.jsonl)

  sessionWatcher.syncWithService('running')
  await sleep(500)

  const tracked = sessionWatcher._debugState()
  console.log('\n=== 基线 ===')
  console.log('sessions 目录下的实时文件：')
  for (const ws of fs.readdirSync(path.join(fakeHome, 'sessions'))) {
    for (const s of fs.readdirSync(path.join(fakeHome, 'sessions', ws))) {
      const files = fs.readdirSync(path.join(fakeHome, 'sessions', ws, s))
      console.log(`  ${s}: ${files.filter((f) => f !== 'mid-frame.tmp').join(', ')}`)
    }
  }
  console.log(`watcher tracked 会话数: ${tracked.size}`)
  console.log(`  （期望 2；实际 ${tracked.size} ⇒ 未进入 tracked 的会话永远不会产出通知）`)

  // 两个会话各追加一轮 turn/end
  zstdFrame(turnEnd(1), legacy.mid)
  append(legacy)
  zstdFrame(turnEnd(1), v3.mid)
  append(v3)

  await sleep(1500)

  console.log('\n=== 追加一轮 turn/end 后 ===')
  console.log(`complete 事件数: ${completed.length}`)
  for (const ev of completed) console.log(`  → uuid=${ev.uuid} turn=${ev.turn}`)
  console.log(`\n结论: 旧命名会话${completed.some((e) => e.uuid === legacy.uuid) ? '已' : '未'}通知；` +
    `v3 命名会话${completed.some((e) => e.uuid === v3.uuid) ? '已' : '未'}通知`)

  fs.rmSync(tmpRoot, { recursive: true, force: true })
  app.exit(0)
})
