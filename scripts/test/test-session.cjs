// 对话完成通知（每轮立即通知）集成测试
// 覆盖语义：
//  1) 启动前已含完整轮次的旧会话 → 基线化，不误报
//  2) 观察期每轮 turn/end(非 interrupted) 结束 → 立即通知
//  3) 同一轮重复 turn/end（崩溃修复重写）→ 按轮去重，不重复
//  4) 后续每一轮 → 都立即通知（轮次编号递增）
//  5) 无 turn/end 的会话（进行中的轮次）→ 永不通知（无「停止写入」兜底）
//  6) turn/end(interrupted)（崩溃恢复合成）→ 不通知
const { app } = require('electron')
const child = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.DSH_SESSION_POLL_MS = '150'

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
    const { sessionWatcher, wireSessionWatcher, notificationHub, configStore } = require('../out/session-watcher.cjs')
    wireSessionWatcher()

    // 通知渠道固定为 fake webview：断言实际投递载荷，不弹原生、不扰民
    const received = []
    notificationHub.setWebview({ deliver: (ev) => { received.push(ev); return true } })
    notificationHub.markWebviewReady(true)
    await configStore.set({ notifyChannel: 'webview', notifySessionDone: 'per-turn', notifyAskCard: true })

    const wsName = '--D-test_ws--'
  // 日志文件名按 Session format 代数命名（v0=session.jsonl.zstd / v3=session.v3.jsonl.zstd）。
  // 默认用 v3——内核 0.1.5 起的实际写法，覆盖「通知失效」回归（曾因硬编码旧名而全量失效）。
  const mkSess = (uuid, logName = 'session.v3.jsonl.zstd') => {
    const sessDir = path.join(fakeHome, 'sessions', wsName, `session-${uuid}`)
    const jsonl = path.join(sessDir, logName)
    const mid = path.join(sessDir, 'mid-frame.tmp')
    fs.mkdirSync(sessDir, { recursive: true })
    return { sessDir, jsonl, mid, uuid }
  }
    const append = (jsonl, mid) => fs.appendFileSync(jsonl, fs.readFileSync(mid))

    const completed = []
    sessionWatcher.on('complete', (ev) => completed.push(ev))

    // ---------- 会话 A：正常多轮 ----------
    const A = mkSess('deadbeef-0000-4000-8000-000000000001')

    console.log('1) 启动前已含完整轮次的旧会话 → 不误报')
    const t0 = Date.now()
    zstdFrame(
      [
        { type: 'session', cwd: 'D:\\proj\\demo', id: `session-${A.uuid}` },
        { type: 'user/message', seq: 1, time: t0, data: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
        { type: 'turn/start', seq: 2, time: t0, data: { turn: 1 } },
        { type: 'step/start', seq: 3, time: t0, data: { turn: 1, step: 1 } },
        { type: 'assistant/chunk', seq: 4, time: t0 },
        { type: 'step/end', seq: 5, time: t0, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 6, time: t0, data: { turn: 1, reason: { kind: 'completed' } } }
      ],
      A.jsonl
    )
    sessionWatcher.syncWithService('running')
    await sleep(400)
    assert(sessionWatcher._debugState().size === 1, '基线跟踪 1 个会话')
    assert(completed.length === 0, '启动前旧会话不误报（历史 turn/end 不通知）')

    console.log('2) 观察期第 1 轮 turn/end(completed) → 立即通知')
    const t1 = Date.now()
    zstdFrame(
      [
        { type: 'user/message', seq: 7, time: t1, data: { role: 'user', content: [{ type: 'text', text: '继续' }] } },
        { type: 'turn/start', seq: 8, time: t1, data: { turn: 2 } },
        { type: 'assistant/chunk', seq: 9, time: t1 },
        { type: 'turn/end', seq: 10, time: t1, data: { turn: 2, reason: { kind: 'completed' } } }
      ],
      A.mid
    )
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(completed.length === 1, 'turn/end 出现即完成（1 次，无需静默等待）')
    assert(completed[0].uuid === A.uuid, '携带 uuid')
    assert(completed[0].turn === 2, '携带轮次编号')

    // v0.9.5 文案（本用例是用户报的「项目（项目名）·问题」那条通知）：
    // 项目名移入标题行，正文只留会话标题 + 轮次
    const doneEv = received.filter((e) => e.kind === 'session-done').pop()
    assert(doneEv?.title === 'demo · DSH 对话完成', '完成通知标题行 = 项目名 · DSH 对话完成（cwd=D:\\proj\\demo）', doneEv?.title)
    assert(!/项目「/.test(doneEv?.body ?? ''), '完成通知正文不再带「项目「X」·」前缀', doneEv?.body)
    assert(/（第 2 轮）$/.test(doneEv?.body ?? ''), '完成通知正文以「（第 N 轮）」结尾', doneEv?.body)

    console.log('3) 同一轮重复 turn/end（崩溃修复重写场景）→ 按轮去重')
    const t2 = Date.now()
    zstdFrame([{ type: 'turn/end', seq: 11, time: t2, data: { turn: 2, reason: { kind: 'completed' } } }], A.mid)
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(completed.length === 1, '同轮重复 turn/end 不重复通知')

    console.log('4) 第 2 轮 turn/end(completed) → 再次立即通知（每轮都弹）')
    const t3 = Date.now()
    zstdFrame(
      [
        { type: 'turn/start', seq: 12, time: t3, data: { turn: 3 } },
        { type: 'turn/end', seq: 13, time: t3, data: { turn: 3, reason: { kind: 'completed' } } }
      ],
      A.mid
    )
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(completed.length === 2, '第 3 轮结束立即完成（第 2 次通知）')
    assert(completed[1].turn === 3, '轮次编号递增')

    // ---------- 会话 B：进行中但无 turn/end ----------
    const B = mkSess('cafebabe-0000-4000-8000-000000000002')
    console.log('5) 无 turn/end 的会话（进行中的轮次）→ 永不通知（无兜底）')
    zstdFrame(
      [
        { type: 'session', cwd: 'D:\\other', id: `session-${B.uuid}` },
        { type: 'user/message', seq: 1, time: t0, data: { role: 'user', content: [{ type: 'text', text: '长任务…' }] } },
        { type: 'step/start', seq: 2, time: t0, data: { turn: 1, step: 1 } },
        { type: 'assistant/chunk', seq: 3, time: t0 }
      ],
      path.join(B.sessDir, 'head.tmp')
    )
    fs.copyFileSync(path.join(B.sessDir, 'head.tmp'), B.jsonl)
    await sleep(250) // 基线
    const t5 = Date.now()
    zstdFrame([{ type: 'assistant/chunk', seq: 4, time: t5 }], B.mid)
    append(B.jsonl, B.mid)
    await sleep(400)
    assert(completed.length === 2, '进行中的轮次不通知')
    await sleep(700) // 模拟超过旧「停止写入」兜底阈值
    assert(completed.length === 2, '无 turn/end 永不通知（无兜底误报）')

    // ---------- 会话 C：崩溃恢复合成的 interrupted ----------
    const C = mkSess('12345678-0000-4000-8000-000000000003')
    console.log('6) turn/end(interrupted)（崩溃合成）→ 不通知')
    zstdFrame([{ type: 'session', cwd: 'D:\\crash', id: `session-${C.uuid}` }], path.join(C.sessDir, 'head.tmp'))
    fs.copyFileSync(path.join(C.sessDir, 'head.tmp'), C.jsonl)
    await sleep(250)
    const t6 = Date.now()
    zstdFrame(
      [
        { type: 'turn/start', seq: 1, time: t6, data: { turn: 1 } },
        { type: 'assistant/chunk', seq: 2, time: t6 },
        { type: 'turn/end', seq: 3, time: t6, data: { turn: 1, reason: { kind: 'interrupted' } } }
      ],
      C.mid
    )
    append(C.jsonl, C.mid)
    await sleep(400)
    assert(completed.length === 2, 'interrupted 不通知')
    await sleep(700)
    assert(completed.length === 2, 'interrupted 持续不通知')

    // ---------- 会话 D：旧命名（v0）——确认不因改解析逻辑而丢掉老会话 ----------
    const D = mkSess('aaaaaaaa-0000-4000-8000-000000000004', 'session.jsonl.zstd')
    console.log('7) 旧命名 session.jsonl.zstd（未迁移世代）→ 仍能通知')
    zstdFrame([{ type: 'session', cwd: 'D:\\legacy', id: `session-${D.uuid}` }], path.join(D.sessDir, 'head.tmp'))
    fs.copyFileSync(path.join(D.sessDir, 'head.tmp'), D.jsonl)
    await sleep(250)
    zstdFrame(
      [
        { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
        { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }
      ],
      D.mid
    )
    append(D.jsonl, D.mid)
    await sleep(400)
    assert(completed.length === 3, '旧命名会话仍正常通知（向后兼容）')
    assert(completed[2].uuid === D.uuid, '旧命名会话 uuid 正确')

    // ---------- 会话 E：v0/v3 并存（内核格式迁移现场）→ 必须读 v3 ----------
    const E = mkSess('bbbbbbbb-0000-4000-8000-000000000005')
    console.log('8) v0 与 v3 并存（格式迁移现场）→ 读最高代数 v3')
    // v0 是迁移前的陈旧内容（含一个已完成轮次），v3 是迁移后的当前内容
    zstdFrame(
      [
        { type: 'session', cwd: 'D:\\migrated', id: `session-${E.uuid}` },
        { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
        { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }
      ],
      path.join(E.sessDir, 'session.jsonl.zstd')
    )
    zstdFrame(
      [
        { type: 'session', cwd: 'D:\\migrated', id: `session-${E.uuid}` },
        { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }
      ],
      E.jsonl
    )
    sessionWatcher._debugState().clear() // 强制重新基线化（模拟重启后重新扫描）
    await sleep(400)
    const trackedE = [...sessionWatcher._debugState().values()].find((v) => v.file.endsWith('session.v3.jsonl.zstd'))
    assert(!!trackedE, '并存时跟踪的是 v3（而非陈旧的 v0）')
    const before = completed.length
    zstdFrame([{ type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }], E.mid)
    append(E.jsonl, E.mid)
    await sleep(400)
    assert(completed.length === before + 1, 'v3 新增轮次能通知（偏移落在 v3 上解析正确）')
    assert(completed[completed.length - 1].uuid === E.uuid, '通知归属并存会话')
    assert(completed[completed.length - 1].turn === 1, '解析出的轮次编号正确（证明确实读的 v3）')

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
