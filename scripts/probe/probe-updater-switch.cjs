// 实机探针：验证「自动检查 / 自动下载」两个开关真的改到了 electron-updater 的策略位
//
// 为什么需要它：单测里 app.isPackaged=false → canAutoUpdate=false →
// applyAutoSwitches() 是 no-op，只能断言「不抛异常」，无法证明开关真的生效。
// 本探针把 app.isPackaged 伪造成「安装版」场景，直接观察
// autoUpdater.autoDownload / autoInstallOnAppQuit 的真实取值（四种组合全走一遍）。
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = path.join(os.tmpdir(), 'dsh-updater-probe-' + Date.now())
app.setPath('userData', path.join(tmpRoot, 'userdata'))
app.setName('DshUpdaterProbe')

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label, detail !== undefined ? ' — ' + JSON.stringify(detail) : '') }
}

// 伪装成安装版（NSIS）：electron-updater 只在 app.isPackaged && !portable 时启用
const pk = Object.getOwnPropertyDescriptor(app, 'isPackaged')
try {
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true })
} catch (e) {
  console.error('无法伪造 app.isPackaged：', e.message)
  process.exit(1)
}
delete process.env.PORTABLE_EXECUTABLE_DIR

app.whenReady().then(async () => {
  try {
    const { updater, configStore } = require('../out/updater.cjs')
    const { autoUpdater } = require('electron-updater')

    console.log('0) 前提：canAutoUpdate 已为真（伪装安装版成功）')
    assert(app.isPackaged === true, 'app.isPackaged 已伪装为 true')
    assert(updater.canAutoUpdate !== false, 'updater 认为是可自动更新场景')

    console.log('1) 默认（两开关均开）→ init()：autoDownload / autoInstallOnAppQuit 均为 true')
    fs.mkdirSync(path.join(tmpRoot, 'userdata'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'userdata', 'config.json'), JSON.stringify({ autoCheckUpdate: true, autoDownloadUpdate: true }), 'utf-8')
    configStore.init()
    updater.init()
    assert(autoUpdater.autoDownload === true, 'init()：autoDownload=true', autoUpdater.autoDownload)
    assert(autoUpdater.autoInstallOnAppQuit === true, 'init()：autoInstallOnAppQuit=true', autoUpdater.autoInstallOnAppQuit)

    console.log('2) 关键组合：开检查 + 关下载（“可以查，但别偷我带宽”）')
    await configStore.set({ autoCheckUpdate: true, autoDownloadUpdate: false })
    updater.applyAutoSwitches()
    assert(updater.isAutoCheckEnabled() === true, '自动检查仍为开', updater.isAutoCheckEnabled())
    assert(autoUpdater.autoDownload === false, 'autoDownload=false（检查到也不自动下）', autoUpdater.autoDownload)
    assert(autoUpdater.autoInstallOnAppQuit === false, 'autoInstallOnAppQuit=false（不静默替换安装包）', autoUpdater.autoInstallOnAppQuit)

    console.log('3) 组合：关检查 + 开下载（不后台查，但允许下）→ autoDownload 跟随下载开关')
    await configStore.set({ autoCheckUpdate: false, autoDownloadUpdate: true })
    updater.applyAutoSwitches()
    assert(updater.isAutoCheckEnabled() === false, '自动检查已关', updater.isAutoCheckEnabled())
    assert(autoUpdater.autoDownload === true, 'autoDownload=true（只看下载开关，不被检查开关牵连）', autoUpdater.autoDownload)

    console.log('4) 组合：两开关均关 → 两个策略位都 false')
    await configStore.set({ autoCheckUpdate: false, autoDownloadUpdate: false })
    updater.applyAutoSwitches()
    assert(autoUpdater.autoDownload === false, 'autoDownload=false', autoUpdater.autoDownload)
    assert(autoUpdater.autoInstallOnAppQuit === false, 'autoInstallOnAppQuit=false', autoUpdater.autoInstallOnAppQuit)

    console.log('5) 开关可反复切换回默认态')
    await configStore.set({ autoCheckUpdate: true, autoDownloadUpdate: true })
    updater.applyAutoSwitches()
    assert(autoUpdater.autoDownload === true, '恢复 autoDownload=true', autoUpdater.autoDownload)
    assert(autoUpdater.autoInstallOnAppQuit === true, '恢复 autoInstallOnAppQuit=true', autoUpdater.autoInstallOnAppQuit)

    console.log('6) 手动下载路径不受「自动下载」开关限制（关掉开关仍能手动下）')
    await configStore.set({ autoCheckUpdate: true, autoDownloadUpdate: false })
    updater.applyAutoSwitches()
    assert(autoUpdater.autoDownload === false, '前置：自动下载已关')
    // 伪造下载通道：只验证「关着开关时 downloadUpdate 依然被调到」，不触发真实网络
    const realDownload = autoUpdater.downloadUpdate
    const realCfuForDl = autoUpdater.checkForUpdates
    let downloadCalls = 0
    autoUpdater.downloadUpdate = () => { downloadCalls++; return Promise.resolve([]) }
    autoUpdater.checkForUpdates = () => Promise.resolve({ updateInfo: { version: '99.0.0' } })
    // 让 download() 的前置守卫通过：需要 cache 处于 available 且未下载
    await updater.check(true).catch(() => {})
    updater.cache = { ...updater.base(), latest: '99.0.0', available: true, url: 'https://example.invalid/r' }
    const dr = await updater.download()
    autoUpdater.downloadUpdate = realDownload
    autoUpdater.checkForUpdates = realCfuForDl
    assert(downloadCalls === 1, '自动下载关闭时 download() 仍调用 downloadUpdate()（手动路径不受开关约束）', downloadCalls)
    assert(dr.ok === true, 'download() 返回 ok:true', dr)
    assert(autoUpdater.autoDownload === false, '手动下载后 autoDownload 仍保持关闭（无状态泄漏）', autoUpdater.autoDownload)

    console.log('7) 边界：检查抛错时不得留下被改写的策略位')
    const realCfu = autoUpdater.checkForUpdates
    autoUpdater.checkForUpdates = () => Promise.reject(new Error('probe-forced-failure'))
    const r = await updater.check(true)
    autoUpdater.checkForUpdates = realCfu
    assert(typeof r.error === 'string' && r.error.includes('probe-forced-failure'), '失败被记录进 UpdateInfo.error', r.error)
    assert(autoUpdater.autoDownload === false, '抛错后 autoDownload 未被改写（仍是开关值 false）', autoUpdater.autoDownload)

    console.log('8) UpdateInfo.autoUpdateSupported 在安装版下为 true')
    // 直接读 base()：避免为了拿一个布尔字段而触发真实 checkForUpdates（会去读 app-update.yml 报噪音）
    assert(updater.base().autoUpdateSupported === true, '伪装安装版 → autoUpdateSupported=true', updater.base().autoUpdateSupported)

    if (pk) Object.defineProperty(app, 'isPackaged', pk)
  } catch (e) {
    console.error('PROBE CRASH:', e)
    failed++
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})
