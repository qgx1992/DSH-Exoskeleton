// 通知事件中枢（notification-hub）集成测试
// 覆盖语义（设计 NOTIFICATION-PLUGIN-DESIGN.md §4.1/§5.2）：
//  1) per-turn：webview 在线优先（auto），事件原样投递、id 保留
//  2) aggregate：同一会话窗口内 N 轮合并为一条「已完成 N 轮」（10 轮连发只产 1 条的依据）
//  3) aggregate：窗口内仅 1 轮 → 原样投递（避免无谓延迟）
//  4) notifySessionDone=off：会话完成不投递
//  5) notifyServiceEvents 开关过滤服务事件
//  6) handleViewMessage：ready 握手 / click（携带 sessionId 调回调）/ seen 回执
//  7) 降级：webview 离线 + auto → 生效渠道 native，投递不抛异常；channel 状态可见
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = path.join(os.tmpdir(), 'dsh-notify-test-' + Date.now())
app.setPath('userData', path.join(tmpRoot, 'userdata'))
app.setName('DshNotifyTest')

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label, detail !== undefined ? '— ' + JSON.stringify(detail) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  try {
    const { notificationHub, configStore } = require('./out/notification-hub.cjs')

    // 观察 deliver 的假 webview 通道 + click 回调
    const received = []
    notificationHub.setWebview({ deliver: (ev) => { received.push(ev); return true } })
    const clicked = []
    notificationHub.setOnClick((sessionId) => clicked.push(sessionId))
    notificationHub.markWebviewReady(true)

    const mk = (kind, extra) => ({
      id: 'ev-' + Math.random().toString(36).slice(2),
      kind,
      title: 'DSH 对话完成',
      body: '项目「foo」· 标题',
      ts: Date.now(),
      ...extra
    })

    // 0) 配置迁移：旧 notifySessionDone boolean → 新枚举（config.ts normalize）
    console.log('0) 配置迁移：旧 boolean → 新枚举')
    fs.mkdirSync(path.join(tmpRoot, 'userdata'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'userdata', 'config.json'), JSON.stringify({ notifySessionDone: true }), 'utf-8')
    assert(configStore.get().notifySessionDone === 'per-turn', 'true → per-turn')
    // 触发一次落盘（set）后，磁盘上应存新枚举（写入一律存枚举）
    await configStore.set({ notifySessionDone: 'per-turn' })
    configStore.flush() // R-16 防抖落盘：测试需立即读盘，先 flush
    const disk1 = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'userdata', 'config.json'), 'utf-8'))
    assert(disk1.notifySessionDone === 'per-turn', '落盘为枚举 per-turn（非 boolean）', disk1.notifySessionDone)
    fs.writeFileSync(path.join(tmpRoot, 'userdata', 'config.json'), JSON.stringify({ notifySessionDone: false }), 'utf-8')
    configStore.init()
    assert(configStore.get().notifySessionDone === 'off', 'false → off')

    console.log('1) per-turn：webview 在线优先（auto）')
    await configStore.set({ notifyChannel: 'auto', notifySessionDone: 'per-turn', notifyAggregateWindowMs: 20000, notifyServiceEvents: true })
    assert(configStore.get().notifySessionDone === 'per-turn', 'notifySessionDone 为新枚举 per-turn')
    const aEv1 = mk('session-done', { session: { uuid: 'a-1' } })
    const aEv2 = mk('session-done', { session: { uuid: 'a-2' } })
    notificationHub.dispatch(aEv1)
    notificationHub.dispatch(aEv2)
    assert(received.length === 2, 'per-turn：2 条原样投递 webview', received.length)
    assert(received[0].id === aEv1.id && received[1].id === aEv2.id, 'per-turn：事件 id 保留')
    assert(received[0].actions === undefined, 'webview 载荷剥离主进程 actions')

    console.log('2) aggregate：同一会话窗口内 N 轮合并为一条')
    received.length = 0
    await configStore.set({ notifySessionDone: 'aggregate', notifyAggregateWindowMs: 400 })
    const u = 'same-uuid-1'
    notificationHub.dispatch(mk('session-done', { session: { uuid: u } }))
    notificationHub.dispatch(mk('session-done', { session: { uuid: u } }))
    notificationHub.dispatch(mk('session-done', { session: { uuid: u } }))
    assert(received.length === 0, 'aggregate：窗口内不立即投递', received.length)
    await sleep(500)
    assert(received.length === 1, 'aggregate：窗口结束 flush 一条', received.length)
    assert(/已完成 3 轮/.test(received[0]?.body ?? ''), 'aggregate：正文为「已完成 3 轮」', received[0] && received[0].body)
    await sleep(150)

    console.log('3) aggregate：窗口内仅 1 轮 → 原样投递')
    received.length = 0
    notificationHub.dispatch(mk('session-done', { session: { uuid: 'single-uuid' }, body: '项目「x」· 一轮' }))
    await sleep(500)
    assert(received.length === 1, 'aggregate：单轮 flush 一条', received.length)
    assert(received[0].body === '项目「x」· 一轮', 'aggregate：单轮保持原正文', received[0] && received[0].body)
    await sleep(150)

    console.log('4) off：会话完成不投递')
    received.length = 0
    await configStore.set({ notifySessionDone: 'off' })
    notificationHub.dispatch(mk('session-done', { session: { uuid: 'off-uuid' } }))
    await sleep(350)
    assert(received.length === 0, 'off：会话完成不投递', received.length)

    console.log('5) 服务事件开关：notifyServiceEvents 过滤')
    received.length = 0
    await configStore.set({ notifyServiceEvents: false, notifySessionDone: 'per-turn' })
    notificationHub.dispatch(mk('service-error', { title: 'DSH 服务异常', service: { error: 'boom' } }))
    assert(received.length === 0, '服务事件 off：过滤')
    await configStore.set({ notifyServiceEvents: true })
    notificationHub.dispatch(mk('update-ready', { title: '更新已就绪', update: { version: '9.9.9' } }))
    assert(received.length === 1, '服务/更新事件 on：投递（非会话不受粒度开关影响）')

    console.log('6) handleViewMessage：ready 握手 / click / install / seen')
    notificationHub.markWebviewReady(false)
    assert(notificationHub.webviewOnline() === false, 'view 重置后 webview 离线')
    notificationHub.handleViewMessage('notify:ready', {})
    assert(notificationHub.webviewOnline() === true, 'notify:ready 握手后 webview 在线')
    clicked.length = 0
    notificationHub.handleViewMessage('notify:click', { id: 'ev-x', sessionId: 'session-abc' })
    assert(clicked.length === 1 && clicked[0] === 'session-abc', 'notify:click 触发壳回调并携带 sessionId', clicked)
    // P2：notify:install → 触发 onInstall 回调（webview 通道「更新就绪」点击）
    const installed = []
    notificationHub.setOnInstall(() => installed.push('install'))
    notificationHub.handleViewMessage('notify:install', { id: 'ev-up' })
    assert(installed.length === 1, 'notify:install 触发壳安装回调', installed)
    notificationHub.handleViewMessage('notify:seen', { id: 'ev-x' })
    assert(true, 'notify:seen 回执不抛异常')

    console.log('7) 降级：webview 离线 + auto → 生效渠道 native')
    notificationHub.markWebviewReady(false)
    await configStore.set({ notifyChannel: 'auto', notifySessionDone: 'per-turn' })
    assert(notificationHub.status().channel === 'native', 'auto + webview 离线 → native', notificationHub.status())
    received.length = 0
    notificationHub.dispatch(mk('session-done', { session: { uuid: 'deg' } })) // 降级 native，不抛
    await sleep(100)
    assert(received.length === 0, 'webview 离线：不投递到 webview（native 兜底不抛）', received.length)
    await configStore.set({ notifyChannel: 'native' })
    assert(notificationHub.status().channel === 'native', 'native 强制 → channel native')

    console.log('8) requestActivate：通知点击 → 转发 webview 插件激活（修复「偶尔不跳转」）')
    // webview 在线 → 返回 true 且投递 session-activate 控制事件（不渲染 toast 的载荷语义）
    received.length = 0
    notificationHub.markWebviewReady(true)
    await configStore.set({ notifyChannel: 'auto' })
    const okAct = notificationHub.requestActivate('session-uuid-1')
    assert(okAct === true, 'webview 在线：requestActivate 返回 true')
    assert(received.length === 1 && received[0].kind === 'session-activate' && received[0].session.uuid === 'session-uuid-1', '投递 session-activate 事件且带 sessionId', received)
    // webview 离线 → 返回 false（调用方回退 DOM hack），且不投递原生空通知
    notificationHub.markWebviewReady(false)
    const okOff = notificationHub.requestActivate('session-uuid-2')
    assert(okOff === false, 'webview 离线：requestActivate 返回 false（回退 DOM hack）')
    assert(received.length === 1, 'webview 离线：不再多投递任何事件', received.length)

    console.log('9) auto 路由含窗口激活（焦点感知）：失焦/隐藏/最小化时必须走原生（防漏看）')
    // 注册激活探针：默认非前台焦点
    let activeFlag = false
    notificationHub.setWindowActive(() => activeFlag)
    received.length = 0
    notificationHub.markWebviewReady(true)
    await configStore.set({ notifyChannel: 'auto' })
    notificationHub.dispatch(mk('session-done', { session: { uuid: 'hid-1' } }))
    assert(received.length === 0, '非前台焦点 + webview 在线 + auto → 不投递 webview（走原生）', received)
    // 前台焦点 → webview
    activeFlag = true
    received.length = 0
    notificationHub.dispatch(mk('session-done', { session: { uuid: 'vis-1' } }))
    assert(received.length === 1 && received[0].session.uuid === 'vis-1', '前台焦点 + webview 在线 + auto → 投递 webview', received)
    // 强制 native → 无论焦点都走原生
    received.length = 0
    await configStore.set({ notifyChannel: 'native' })
    notificationHub.dispatch(mk('session-done', { session: { uuid: 'nat-1' } }))
    assert(received.length === 0, 'notifyChannel=native 强制 → 不走 webview', received)
    assert(notificationHub.status().channel === 'native', 'status() 反映强制 native', notificationHub.status())
    // 激活回归：恢复默认（无探针 = 前台焦点）
    notificationHub.setWindowActive(null)
    await configStore.set({ notifyChannel: 'auto' })
    received.length = 0
    notificationHub.dispatch(mk('session-done', { session: { uuid: 'def-1' } }))
    assert(received.length === 1, '无探针（默认激活）→ 走 webview（向后兼容）', received)

    console.log('10) 协议激活 URL 解析/兜底（v0.8.2：操作中心点击修复）')
    const { parseNotifyUrl, activateFromUrl } = require('./out/notification-hub.cjs')
    const p1 = parseNotifyUrl('dsh-exo://notify?id=ev-1&session=abc123&kind=session-done')
    assert(p1 && p1.id === 'ev-1' && p1.session === 'abc123' && p1.kind === 'session-done', '标准 dsh-exo://notify URL 解析')
    const p2 = parseNotifyUrl('dsh-exo:notify?id=ev-2')
    assert(p2 && p2.id === 'ev-2', '无 // 形态（dsh-exo:notify?…）解析')
    assert(parseNotifyUrl('https://evil.example/x') === null, '非 dsh-exo 协议拒绝')
    assert(parseNotifyUrl('dsh-exo://other?x=1') === null, '非 notify 段拒绝')
    assert(parseNotifyUrl('dsh-exo://notify?session=../evil') === null, '非法 session（路径穿越）拒绝')
    const rCold = activateFromUrl('dsh-exo://notify?id=ghost&session=uu-1')
    assert(rCold.handled === false && rCold.payload && rCold.payload.id === 'ghost' && rCold.payload.session === 'uu-1', '未命中注册表 → cold 兜底返回 payload（调用方唤起窗口+定位会话）')

    notificationHub.setWebview(null)
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})
