// 会话完成通知检测集成测试（模拟会话文件活动：基线 → 增长 → 停止 → 触发 complete）
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.DSH_SESSION_QUIET_MS = '800' // 测试用短静默阈值
process.env.DSH_SESSION_POLL_MS = '200' // 测试用短轮询间隔

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

app.whenReady().then(async () => {
  try {
    const { sessionWatcher, wireSessionWatcher } = require('./out/session-watcher.cjs')
    wireSessionWatcher()

    // 模拟会话目录结构：sessions/--work-abc--/session-<uuid>/session.jsonl.zstd
    const wsName = '--D-test_ws--'
    const uuid = 'deadbeef-0000-4000-8000-000000000001'
    const sessDir = path.join(fakeHome, 'sessions', wsName, `session-${uuid}`)
    const jsonl = path.join(sessDir, 'session.jsonl.zstd')
    fs.mkdirSync(sessDir, { recursive: true })

    const completed = []
    sessionWatcher.on('complete', (ev) => completed.push(ev))

    console.log('1) 预建会话文件 + 启动 watcher（基线扫描）')
    fs.writeFileSync(jsonl, Buffer.alloc(1000, 1)) // 初始内容（启动前已存在）
    sessionWatcher.syncWithService('running')
    await sleep(250)
    assert(sessionWatcher._debugState().size === 1, '基线记录 1 个会话')

    console.log('2) 会话活跃（文件增长）')
    fs.writeFileSync(jsonl, Buffer.concat([Buffer.alloc(1000, 1), Buffer.alloc(500, 2)]))
    await sleep(450) // 跨越 2 个 poll，观察到增长
    assert(completed.length === 0, '活跃期间不通知')

    console.log('3) 会话停止写入 → 判定完成')
    await sleep(1200) // 超过 800ms 静默阈值 + poll
    assert(completed.length === 1, 'complete 触发 1 次')
    assert(completed[0].uuid === uuid, '事件携带 uuid')
    assert(completed[0].workspace === wsName, '事件携带工作区名')
    assert(sessionWatcher._debugState().size === 0, '完成后从跟踪移除')

    console.log('4) 会话完成前窗口隐藏则通知仍发送（wire 已就绪，仅确认不崩溃）')

    console.log('5) 旧会话（观察期从未增长）不误报')
    const uuid2 = 'cafebabe-0000-4000-8000-000000000002'
    const sessDir2 = path.join(fakeHome, 'sessions', wsName, `session-${uuid2}`)
    fs.mkdirSync(sessDir2, { recursive: true })
    fs.writeFileSync(path.join(sessDir2, 'session.jsonl.zstd'), Buffer.alloc(800, 3)) // 无后续增长
    await sleep(300) // 基线
    await sleep(900) // 超过阈值但从未增长
    assert(completed.length === 1, '旧会话不触发通知（仍为 1 次）')

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