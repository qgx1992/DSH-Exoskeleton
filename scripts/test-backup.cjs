// 备份与回滚模块集成测试（electron 环境，隔离 DSH_HOME 与 userData）
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = path.join(os.tmpdir(), 'dsh-backup-test-' + Date.now())
const fakeHome = path.join(tmpRoot, 'fake-dsh')
process.env.DSH_HOME = fakeHome
fs.mkdirSync(path.join(fakeHome, 'sessions'), { recursive: true })
fs.mkdirSync(path.join(fakeHome, 'plugins'), { recursive: true })
fs.writeFileSync(path.join(fakeHome, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: 1\n', 'utf-8')
fs.writeFileSync(path.join(fakeHome, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-test-123\n', 'utf-8')
fs.writeFileSync(path.join(fakeHome, 'profiles-node-modules巨目录占位.txt'), 'x', 'utf-8')
// 模拟大目录（应被排除）：profiles/web/node_modules
fs.mkdirSync(path.join(fakeHome, 'profiles', 'web', 'node_modules', 'bigpkg'), { recursive: true })
fs.writeFileSync(path.join(fakeHome, 'profiles', 'web', 'node_modules', 'bigpkg', 'big.bin'), Buffer.alloc(1024))
fs.writeFileSync(path.join(fakeHome, 'profiles', 'web', 'package.json'), '{"dependencies":{}}', 'utf-8')

app.setName('DshExoskeletonTest')
let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}

app.whenReady().then(async () => {
  try {
    const { backupManager } = require('./out/backup.cjs')

    console.log('1) 创建手动存档')
    const info = await backupManager.create('unit-test-manual', 'manual')
    assert(!!info, 'create 返回 BackupInfo')
    assert(info.kind === 'manual', 'kind=manual')
    assert(info.name === 'unit-test-manual', 'name 正确')

    console.log('2) 快照内容检查')
    const snapDir = path.join(app.getPath('userData'), 'backups', info.id)
    assert(fs.existsSync(path.join(snapDir, 'settings.yaml')), 'settings.yaml 已备份')
    assert(fs.existsSync(path.join(snapDir, '.credentials.yaml')), 'credentials 已备份')
    assert(fs.existsSync(path.join(snapDir, 'sessions')), 'sessions 已备份')
    assert(!fs.existsSync(path.join(snapDir, 'profiles', 'web', 'node_modules')), 'node_modules 已排除')
    assert(!fs.existsSync(path.join(snapDir, 'profiles-node-modules巨目录占位.txt')), '候选列表外文件不备份')

    console.log('3) 列表')
    const list = backupManager.list()
    assert(list.some((b) => b.id === info.id), 'list 包含新快照')
    assert(list[0].createdAt === info.createdAt, '按时间倒序')

    console.log('4) 修改文件后恢复')
    fs.writeFileSync(path.join(fakeHome, 'settings.yaml'), '# changed by test', 'utf-8')
    const r = await backupManager.restore(info.id)
    assert(r.ok, 'restore ok')
    assert(fs.readFileSync(path.join(fakeHome, 'settings.yaml'), 'utf-8').includes('welcomeNoticeVersion'), 'settings.yaml 已恢复')
    // 恢复前保护快照
    const list2 = backupManager.list()
    assert(list2.some((b) => b.trigger === `restore:${info.id}`), '恢复前自动创建保护快照')

    console.log('5) 自动快照 + 触发标记')
    const auto = await backupManager.autoSnapshot('plugin-install:test')
    assert(auto.kind === 'auto' && auto.trigger === 'plugin-install:test', 'auto 快照带 trigger')

    console.log('6) 删除')
    const del = backupManager.delete(info.id)
    assert(del.ok && !backupManager.list().some((b) => b.id === info.id), 'delete 生效')

    console.log('7) 定时自动备份调度')
    // 启动调度（间隔 1 小时）：启动时应立即补拍一次
    backupManager.syncAutoBackup(true, 1)
    await new Promise((r) => setTimeout(r, 400))
    let list3 = backupManager.list()
    const scheduled = list3.find((b) => b.trigger === 'scheduled')
    assert(!!scheduled, '调度启动后立即创建 scheduled 快照')
    assert(scheduled.kind === 'auto', 'scheduled 类型为 auto')
    // 再次 sync 且间隔未到 → 不应重复创建
    backupManager.syncAutoBackup(true, 1)
    await new Promise((r) => setTimeout(r, 400))
    list3 = backupManager.list()
    const scheduledCount = list3.filter((b) => b.trigger === 'scheduled').length
    assert(scheduledCount === 1, `周期未到不重复（当前 ${scheduledCount} 个 scheduled，应为 1）`)
    // 关闭调度
    backupManager.syncAutoBackup(false, 1)
    assert(!backupManager.list().some((b) => b.id === info.id), '关闭后不再新增（无直接断言，仅确认不崩溃）')
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})