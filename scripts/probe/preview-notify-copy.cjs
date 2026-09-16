// 端到端预览：跑真实 watcher→hub 链路，打印本次 beta 会实际发出的通知标题/正文。
// 用假 webview 通道拦截投递（不弹原生、不扰民），仅打印文案。
const { app } = require('electron')
const child = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.DSH_SESSION_POLL_MS = '150'
const tmpRoot = path.join(os.tmpdir(), 'dsh-copy-probe-' + Date.now())
process.env.DSH_HOME = path.join(tmpRoot, 'fake-dsh')
app.setName('DshCopyProbe')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nodeExe = (() => {
  try { return child.execFileSync('where', ['node'], { encoding: 'utf-8' }).trim().split(/\r?\n/)[0] } catch { return 'node' }
})()
const zstdFrame = (lines, out) =>
  child.execFileSync(nodeExe, ['-e', `
    const z = require('node:zlib'); const fs = require('fs');
    const objs = JSON.parse(process.argv[1]);
    fs.writeFileSync(process.argv[2], z.zstdCompressSync(Buffer.from(objs.map(o => JSON.stringify(o)).join('\\n') + '\\n')));
  `, JSON.stringify(lines), out])

app.whenReady().then(async () => {
  const { sessionWatcher, wireSessionWatcher, notificationHub, configStore } = require('../out/session-watcher.cjs')

  const shown = []
  notificationHub.setWebview({ deliver: (ev) => { shown.push(ev); return true } })
  notificationHub.markWebviewReady(true)
  await configStore.set({ notifyChannel: 'webview', notifySessionDone: 'per-turn', notifyAskCard: true })
  wireSessionWatcher()

  // 与用户现场一致：项目 DSH-Exoskeleton，首句提问即会话标题
  const cwd = 'D:\\A-my project\\研究agent桌面端\\DSH-Exoskeleton'
  const ask = '检查通知功能为什么失效了'
  const uuid = 'aaaa0000-0000-4000-8000-000000000001'
  const ws = '--D-test--'
  const sessDir = path.join(process.env.DSH_HOME, 'sessions', ws, `session-${uuid}`)
  fs.mkdirSync(sessDir, { recursive: true })
  const file = path.join(sessDir, 'session.v3.jsonl.zstd')
  const mid = path.join(sessDir, 'mid.tmp')

  const now = Date.now()
  // 与真实日志同构：首句提问会被写成**两个** session/title——
  // 先是一个截断的临时标题，再是 AI 重命名后的正式会话名（内核 findLast 取后者）。
  zstdFrame([
    { type: 'session', cwd, id: `session-${uuid}` },
    { type: 'user/message', seq: 1, time: now, data: { role: 'user', content: [{ type: 'text', text: ask }] } },
    { type: 'session/title', seq: 2, time: now, data: { title: '检查通知功能为什么' } },
    { type: 'session/title-llm-request', seq: 3, time: now, data: {} },
    { type: 'session/title', seq: 4, time: now, data: { title: '通知失效问题排查' } },
    { type: 'turn/start', seq: 5, time: now, data: { turn: 1 } }
  ], file)

  sessionWatcher.syncWithService('running')
  await sleep(600)

  // 第 3 轮：turn/start → 真实提问（后面跟一条系统注入的伪用户消息，应被过滤）
  zstdFrame([
    { type: 'turn/start', seq: 10, time: Date.now(), data: { turn: 3 } },
    { type: 'user/message', seq: 11, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text: '顺便把通知文案也改成能看出轮次的' }] } },
    { type: 'user/message', seq: 12, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context.' }] } },
    { type: 'turn/end', seq: 13, time: Date.now(), data: { turn: 3, reason: { kind: 'completed' } } }
  ], mid)
  fs.appendFileSync(file, fs.readFileSync(mid))
  await sleep(700)

  // 询问卡 → 等待回答通知
  zstdFrame([{
    type: 'tool/call', seq: 20, time: Date.now(),
    data: { turn: 4, step: 1, callId: 'c1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ header: '交互确认', question: '要不要保留旧配置？' }] }) }
  }], mid)
  fs.appendFileSync(file, fs.readFileSync(mid))
  await sleep(700)

  console.log('\n================ beta 实际通知文案 ================')
  for (const ev of shown) {
    const label = ev.kind === 'session-done' ? '对话完成' : ev.kind === 'session-ask' ? '等待回答' : ev.kind
    console.log(`\n[${label}]`)
    console.log('  标题 │ ' + ev.title)
    console.log('  正文 │ ' + ev.body)
  }
  console.log('\n===================================================')

  sessionWatcher.stop()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  app.exit(0)
})
