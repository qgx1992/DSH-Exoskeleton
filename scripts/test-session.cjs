// 会话完成通知（事件驱动）集成测试
// zstd 帧由系统 Node(有 zstd) 生成；watcher 通过 zstd-worker（系统 Node）解压检测 turn/end
const { app } = require('electron')
const child = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.DSH_SESSION_POLL_MS = '150'
process.env.DSH_SESSION_QUIET_MS = '500'

const tmpRoot = path.join(os.tmpdir(), 'dsh-session-test-' + Date.now())
const fakeHome = path.join(tmpRoot, 'fake-dsh')
process.env.DSH_HOME = fakeHome
app.setName('DshSessionTest')

let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const nodeExe = (() => {
  try { const p = child.execFileSync('where', ['node'], { encoding: 'utf-8' }).trim().split(/\r?\n/)[0]; return p } catch { return 'node' }
})()
// 用系统 node 生成单帧 zstd（每行一个 JSON 事件）
const zstdFrame = (lines, out) => {
  child.execFileSync(nodeExe, ['-e', `
    const z = require('node:zlib'); const fs = require('fs');
    const objs = JSON.parse(process.argv[1]);
    fs.writeFileSync(process.argv[2], z.zstdCompressSync(Buffer.from(objs.map(o => JSON.stringify(o)).join('\\n') + '\\n')));
  `, JSON.stringify(lines), out])
}

app.whenReady().then(async () => {
  try {
    const { sessionWatcher, wireSessionWatcher } = require('./out/session-watcher.cjs')
    wireSessionWatcher()

    const wsName = '--D-test_ws--'
    const uuid = 'deadbeef-0000-4000-8000-000000000001'
    const sessDir = path.join(fakeHome, 'sessions', wsName, `session-${uuid}`)
    const jsonl = path.join(sessDir, 'session.jsonl.zstd')
    const mid = path.join(sessDir, 'mid-frame.tmp')
    fs.mkdirSync(sessDir, { recursive: true })

    const completed = []
    sessionWatcher.on('complete', (ev) => completed.push(ev))

    console.log('1) 基线：写入会话头帧后启动 watcher')
    zstdFrame([{ type: 'session', cwd: 'D:\\proj\\demo', id: `session-${uuid}` }], jsonl)
    sessionWatcher.syncWithService('running')
    await sleep(400)
    assert(sessionWatcher._debugState().size === 1, '基线跟踪 1 个会话')
    assert(completed.length === 0, '会话头不触发完成')

    console.log('2) 事件驱动：追加含 turn/end 的帧 → 立即完成（无需停写等待）')
    zstdFrame(
      [
        { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
        { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } },
        { type: 'assistant/chunk', seq: 3 },
        { type: 'step/end', seq: 4, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } }
      ],
      mid
    )
    fs.appendFileSync(jsonl, fs.readFileSync(mid))
    await sleep(500) // > poll 150ms + worker 往返
    assert(completed.length === 1, 'turn/end 出现后立即 complete（1 次）')
    assert(completed[0].uuid === uuid, '携带 uuid')

    console.log('3) 追加无 turn/end 的帧 → 不重复触发')
    zstdFrame([{ type: 'user/message', seq: 6, data: { role: 'user', content: [] } }], mid)
    fs.appendFileSync(jsonl, fs.readFileSync(mid))
    await sleep(500)
    assert(completed.length === 1, '仍为 1 次（不重复通知）')

    console.log('4) 兜底分支：无 turn/end 的会话，停止写入超阈值才完成')
    const uuid2 = 'cafebabe-0000-4000-8000-000000000002'
    const sessDir2 = path.join(fakeHome, 'sessions', wsName, `session-${uuid2}`)
    fs.mkdirSync(sessDir2, { recursive: true })
    zstdFrame([{ type: 'session', cwd: 'D:\\other' }], path.join(sessDir2, 'head.tmp'))
    const jl2 = path.join(sessDir2, 'session.jsonl.zstd')
    fs.copyFileSync(path.join(sessDir2, 'head.tmp'), jl2)
    await sleep(250) // 让 watcher 基线记录 head（readOffset = head 大小，seen=false）
    zstdFrame([{ type: 'user/message', seq: 1 }], mid)
    fs.appendFileSync(jl2, fs.readFileSync(mid))
    await sleep(400) // 观察到增长 → seen=true
    assert(completed.length === 1, '无 turn/end 不立即完成')
    // debug 兜底状态
    const dbg = [...sessionWatcher._debugState().entries()].map(([k, v]) => `${k.split(path.sep).pop()} off=${v.readOffset} grew=${Math.round((Date.now() - v.lastGrewAt) / 100) / 10}s seen=${v.seen}`)
    console.log('   兜底前状态:', dbg.join(' | '))
    await sleep(700) // 超过 QUIET_MS=500
    console.log('   兜底后完成数:', completed.length)
    assert(completed.length === 2, '兜底判定完成（第 2 次）')
    assert(completed[1].uuid === uuid2, '兜底事件 uuid')

    sessionWatcher.stop()
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})