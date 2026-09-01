// 询问卡等待通知（session-ask）集成测试
// 检测原理：ask_user_question/exit_plan_mode 的 tool/call 入日志而同 callId 的
// tool/result 未出现 ⇒ 卡片等待中；result 配对到达 ⇒ 已回答（pending 清理 + 撤销通知）。
// 覆盖语义：
//  1) 启动前已挂着的卡片（call 无 result）→ 基线化，不误报
//  2) 观察期 tool/call(ask_user_question) → askOpen 事件 + hub 投递 session-ask（正文含问题文本）
//  3) 非白名单工具（pwsh）call 无 result → 不触发（慢工具 ≠ 询问卡）
//  4) exit_plan_mode call → 触发，questions 含计划审批摘要
//  5) tool/result 配对 → pending 清空（可重复：回答后再次提问再次通知）
//  6) call+result 同批帧（秒答）→ 不触发
//  7) turn/end(interrupted) → 该轮 pending 清理（崩溃悬挂收敛）
//  8) notifyAskCard=false → askOpen 事件仍发出（检测层不受显示开关影响），hub 不投递
const { app } = require('electron')
const child = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.DSH_SESSION_POLL_MS = '150'

const tmpRoot = path.join(os.tmpdir(), 'dsh-ask-test-' + Date.now())
const fakeHome = path.join(tmpRoot, 'fake-dsh')
process.env.DSH_HOME = fakeHome
app.setName('DshAskTest')
// userData 隔离（同 test-notify.cjs）：不隔离会把 config.json 写进真实 %APPDATA%，
// 且 run 间互相污染（实测：scenario 9 的 set(false) 防抖落盘晚于 quit，残留到后续运行）
app.setPath('userData', path.join(tmpRoot, 'userdata'))

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label, detail !== undefined ? '— ' + JSON.stringify(detail) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// headInfo 首次调用需冷启动 zstd worker 子进程，dispatch 可能超过固定 sleep；
// 对异步链路断言改用轮询等待（最多 5s）
const waitFor = async (fn, timeoutMs = 5000, step = 100) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true
    await sleep(step)
  }
  return fn()
}

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

// 事件构造器（与真实会话日志同构：data.callId / data.message.source.callId）
let seq = 100
const askCall = (turn, callId, questions) => ({
  type: 'tool/call', seq: ++seq, time: Date.now(),
  data: { turn, step: turn, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions }) }
})
const planCall = (turn, callId, plan) => ({
  type: 'tool/call', seq: ++seq, time: Date.now(),
  data: { turn, step: turn, callId, name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) }
})
const otherCall = (turn, callId, name) => ({
  type: 'tool/call', seq: ++seq, time: Date.now(),
  data: { turn, step: turn, callId, name: name || 'pwsh', arguments: '{}' }
})
const result = (turn, callId) => ({
  type: 'tool/result', seq: ++seq, time: Date.now(),
  data: { turn, step: turn, message: { source: { kind: 'tool', callId }, content: [], role: 'user' } }
})
const turnEnd = (turn, kind) => ({
  type: 'turn/end', seq: ++seq, time: Date.now(), data: { turn, reason: { kind: kind || 'completed' } }
})

app.whenReady().then(async () => {
  let sessionWatcher, notificationHub, configStore
  try {
    ({ sessionWatcher, wireSessionWatcher, notificationHub, configStore } = require('./out/session-ask.cjs'))

    // hub 拦截：fake webview 通道 + webview 渠道 → 事件不落原生（可断言、不扰民）
    const received = []
    notificationHub.setWebview({ deliver: (ev) => { received.push(ev); return true } })
    notificationHub.markWebviewReady(true)
    await configStore.set({ notifyChannel: 'webview' })

    const wsName = '--D-test_ws--'
    const mkSess = (uuid) => {
      const sessDir = path.join(fakeHome, 'sessions', wsName, `session-${uuid}`)
      const jsonl = path.join(sessDir, 'session.jsonl.zstd')
      const mid = path.join(sessDir, 'mid-frame.tmp')
      fs.mkdirSync(sessDir, { recursive: true })
      return { sessDir, jsonl, mid, uuid }
    }
    const append = (jsonl, mid) => fs.appendFileSync(jsonl, fs.readFileSync(mid))

    const askOpens = []
    sessionWatcher.on('askOpen', (ev) => askOpens.push(ev))

    wireSessionWatcher()

    // ---------- 会话 A ----------
    const A = mkSess('aaaa0000-0000-4000-8000-000000000001')

    console.log('1) 启动前已挂着的卡片（call 无 result）→ 基线化不误报')
    zstdFrame(
      [
        { type: 'session', cwd: 'D:\\proj\\demo', id: `session-${A.uuid}` },
        askCall(1, 'call_base_1', [{ id: 'q1', header: '基线', question: '启动前的问题' }])
      ],
      A.jsonl
    )
    sessionWatcher.syncWithService('running')
    await sleep(400)
    assert(askOpens.length === 0, '启动前旧卡片不误报')

    console.log('2) 观察期 tool/call(ask_user_question) → askOpen + hub 投递 session-ask')
    zstdFrame(
      [
        askCall(2, 'call_A1', [
          { id: 'q1', header: '交互确认', question: '两个按钮的交互方式选哪种？' },
          { id: 'q2', question: '要不要保留旧配置？' }
        ])
      ],
      A.mid
    )
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(askOpens.length === 1, '卡片打开立即检测（1 次）', askOpens.length)
    assert(askOpens[0].callId === 'call_A1' && askOpens[0].uuid === A.uuid && askOpens[0].turn === 2, '事件携带 callId/uuid/turn')
    const gotAskEv = await waitFor(() => received.some((e) => e.kind === 'session-ask'))
    const evA1 = received.find((e) => e.kind === 'session-ask')
    assert(gotAskEv, 'hub 收到 session-ask 事件')
    assert(/交互确认/.test(evA1?.body ?? '') && /要不要保留旧配置/.test(evA1?.body ?? ''), '正文含问题文本', evA1?.body)

    console.log('3) 非白名单工具（pwsh）call 无 result → 不触发')
    zstdFrame([otherCall(2, 'call_A2')], A.mid)
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(askOpens.length === 1, '慢工具不误报为询问卡')

    console.log('4) result 配对 → pending 清空')
    const stateA = () => sessionWatcher._debugState().get(path.join(fakeHome, 'sessions', wsName, `session-${A.uuid}`))
    assert(stateA().pendingAsks.has('call_A1'), '回答前 pending 含 call_A1')
    zstdFrame([result(2, 'call_A1')], A.mid)
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(!stateA().pendingAsks.has('call_A1'), '回答后 pending 清空')
    assert(askOpens.length === 1, '配对不产生新事件')

    console.log('5) 回答后再次提问 → 再次通知（状态可循环）')
    zstdFrame([askCall(3, 'call_A3', [{ id: 'q3', question: '第二次提问' }])], A.mid)
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(askOpens.length === 2 && askOpens[1].callId === 'call_A3', '第二次提问再次触发')
    zstdFrame([result(3, 'call_A3')], A.mid)
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(!stateA().pendingAsks.has('call_A3'), '第二次回答后 pending 清空')

    console.log('6) call+result 同批帧（秒答）→ 不触发')
    zstdFrame([askCall(4, 'call_A4', [{ id: 'q4', question: '秒答' }]), result(4, 'call_A4')], A.mid)
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(askOpens.length === 2, '同批配对不触发', askOpens.length)
    assert(!stateA().pendingAsks.has('call_A4'), '秒答不入 pending')

    console.log('7) turn/end(interrupted) → 该轮 pending 清理（崩溃悬挂收敛）')
    zstdFrame([askCall(5, 'call_A5', [{ id: 'q5', question: '会被中断的问题' }])], A.mid)
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(stateA().pendingAsks.has('call_A5'), '提问后 pending 含 call_A5')
    zstdFrame([turnEnd(5, 'interrupted')], A.mid)
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(!stateA().pendingAsks.has('call_A5'), '中断后该轮 pending 清空')
    assert(!stateA().pendingAsks.has('call_A1'), '其他轮 pending 不受影响')

    // ---------- 会话 B：exit_plan_mode + 开关 ----------
    const B = mkSess('bbbb0000-0000-4000-8000-000000000002')
    console.log('8) exit_plan_mode → 触发，questions 含计划审批摘要')
    zstdFrame(
      [
        { type: 'session', cwd: 'D:\\proj\\demo', id: `session-${B.uuid}` },
        planCall(1, 'call_B1', '# 重构方案\n第一步 分离状态层')
      ],
      B.jsonl
    )
    sessionWatcher.syncWithService('running') // 幂等：重新触发一轮扫描（B 为新会话进入基线）
    await sleep(500)
    // B 是新会话（基线），需在观察期追加一帧触发扫描
    zstdFrame([{ type: 'assistant/chunk', seq: ++seq, time: Date.now() }], B.mid)
    append(B.jsonl, B.mid)
    await sleep(400)
    assert(askOpens.length === 3, '基线不回填 B 会话的 plan 卡（A 已有 3 次：A1/A3/A5）', askOpens.length)

    console.log('9) notifyAskCard=false → askOpen 仍发出（检测与显示解耦），hub 不投递')
    await configStore.set({ notifyAskCard: false })
    const receivedBefore = received.length
    zstdFrame([askCall(6, 'call_A6', [{ id: 'q6', question: '开关关闭期间的提问' }])], A.mid)
    append(A.jsonl, A.mid)
    await sleep(400)
    assert(askOpens.length === 4, 'askOpen 事件仍发出（检测层不 gate）', askOpens.length)
    assert(received.length === receivedBefore, 'hub 不投递（显示开关生效）')
    await configStore.set({ notifyAskCard: true })
    configStore.flush() // 立即落盘，避免 quit 竞态残留 false

    console.log(`\\n结果：${passed} passed, ${failed} failed`)
    process.exitCode = failed > 0 ? 1 : 0
  } catch (err) {
    console.error('test fatal:', err)
    process.exitCode = 1
  } finally {
    // R-16：set 是异步防抖落盘，退出前 flush，否则最后一次 set 不落盘（残留旧值污染下次运行）
    try { configStore?.flush?.() } catch { /* noop */ }
    sessionWatcher?.stop?.()
    setTimeout(() => app.quit(), 100)
  }
})
