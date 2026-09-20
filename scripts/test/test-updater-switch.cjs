// 自动更新双开关（config.autoCheckUpdate / autoDownloadUpdate）行为测试
// 覆盖语义：
//  1) 老配置无这两个字段 → 均视为开启（沿用历史行为，不打扰升级用户）
//  2) autoCheckUpdate=false → 后台检查完全不发起；autoDownloadUpdate=true 也拦不住（正交）
//  3) autoCheckUpdate=true  → 后台检查照常发起一次
//  4) 运行期切换 → applyAutoSwitches() 在非安装版下为安全 no-op（不抛异常）
//  5) 落盘为布尔值（避免 undefined 语义漂移）
//  6) download() 的入参守卫：未检查/无更新/下载中时的错误提示（不触发真实网络）
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = path.join(os.tmpdir(), 'dsh-updater-switch-' + Date.now())
app.setPath('userData', path.join(tmpRoot, 'userdata'))
app.setName('DshUpdaterSwitchTest')

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label, detail !== undefined ? ' — ' + JSON.stringify(detail) : '') }
}

app.whenReady().then(async () => {
  try {
    const { updater, configStore } = require('../out/updater.cjs')

    console.log('1) 默认语义：老配置无开关字段 → 均视为开启（向后兼容）')
    fs.mkdirSync(path.join(tmpRoot, 'userdata'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'userdata', 'config.json'), JSON.stringify({ port: 0 }), 'utf-8')
    configStore.init()
    assert(configStore.get().autoCheckUpdate !== false, 'autoCheckUpdate 未定义时不返回 false')
    assert(configStore.get().autoDownloadUpdate !== false, 'autoDownloadUpdate 未定义时不返回 false')
    assert(updater.isAutoCheckEnabled() === true, 'isAutoCheckEnabled() → true（沿用历史行为）')
    assert(updater.isAutoDownloadEnabled() === true, 'isAutoDownloadEnabled() → true（沿用历史行为）')

    console.log('2) 关掉自动检查：后台不发起检查（下载开关开着也拦不住——两个开关正交）')
    await configStore.set({ autoCheckUpdate: false, autoDownloadUpdate: true })
    // 用替身计数替代真实网络：只验证「有没有调 check」，不碰网络（测试不依赖外网）
    const realCheck = updater.check
    let checkCalls = 0
    updater.check = () => { checkCalls++; return Promise.resolve({}) }
    updater.checkIfAutoEnabled()
    await new Promise((r) => setTimeout(r, 50))
    assert(checkCalls === 0, 'autoCheckUpdate=false → 不调用 check()（即便 autoDownloadUpdate=true）', checkCalls)
    assert(updater.isAutoCheckEnabled() === false, 'isAutoCheckEnabled() → false')

    console.log('3) 开回自动检查：后台检查照常发起一次')
    await configStore.set({ autoCheckUpdate: true })
    updater.checkIfAutoEnabled()
    await new Promise((r) => setTimeout(r, 50))
    assert(checkCalls === 1, 'autoCheckUpdate=true → 调用 check() 一次', checkCalls)
    updater.check = realCheck

    console.log('4) 两个开关可独立表达「只查不下」中间态')
    await configStore.set({ autoCheckUpdate: true, autoDownloadUpdate: false })
    assert(updater.isAutoCheckEnabled() === true, '只查不下：检查开', updater.isAutoCheckEnabled())
    assert(updater.isAutoDownloadEnabled() === false, '只查不下：下载关', updater.isAutoDownloadEnabled())
    await configStore.set({ autoCheckUpdate: false, autoDownloadUpdate: true })
    assert(updater.isAutoCheckEnabled() === false, '不查但允许下：检查关')
    assert(updater.isAutoDownloadEnabled() === true, '不查但允许下：下载开')

    console.log('5) 运行期切换：applyAutoSwitches() 安全可用')
    // 测试环境 app.isPackaged=false → canAutoUpdate=false，方法须为 no-op 而不是抛错
    let threw = null
    try {
      for (const combo of [[true, true], [true, false], [false, true], [false, false]]) {
        await configStore.set({ autoCheckUpdate: combo[0], autoDownloadUpdate: combo[1] })
        updater.applyAutoSwitches()
      }
    } catch (e) {
      threw = e.message
    }
    assert(threw === null, 'applyAutoSwitches() 在非安装版下不抛异常（4 种组合轮转）', threw)

    console.log('6) download() 守卫：非安装版给出可读错误，且不触网')
    const d1 = await updater.download()
    assert(d1.ok === false && typeof d1.error === 'string', '非安装版 download() → ok:false 且带错误说明', d1)

    console.log('7) 落盘：两个开关均以布尔值持久化')
    await configStore.set({ autoCheckUpdate: false, autoDownloadUpdate: false })
    configStore.flush() // R-16 防抖落盘：测试需立即读盘
    const disk = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'userdata', 'config.json'), 'utf-8'))
    assert(disk.autoCheckUpdate === false, 'autoCheckUpdate 落盘为布尔 false', disk.autoCheckUpdate)
    assert(disk.autoDownloadUpdate === false, 'autoDownloadUpdate 落盘为布尔 false', disk.autoDownloadUpdate)
    await configStore.set({ autoCheckUpdate: true, autoDownloadUpdate: true })
    configStore.flush()
    const disk2 = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'userdata', 'config.json'), 'utf-8'))
    assert(disk2.autoCheckUpdate === true, '重新开启后 autoCheckUpdate 落盘为布尔 true', disk2.autoCheckUpdate)
    assert(disk2.autoDownloadUpdate === true, '重新开启后 autoDownloadUpdate 落盘为布尔 true', disk2.autoDownloadUpdate)

    console.log('8) UpdateInfo 暴露 autoUpdateSupported（UI 据此决定是否显示「下载更新」按钮）')
    // 直接读 base()：拿一个布尔字段不必触发真实 checkForUpdates（否则单测会依赖外网）
    const info = updater.base()
    assert(typeof info.autoUpdateSupported === 'boolean', 'autoUpdateSupported 为布尔（便携版/开发版 UI 不会给出点了就报错的按钮）', info.autoUpdateSupported)
    assert(info.autoUpdateSupported === false, '测试环境非安装版 → false', info.autoUpdateSupported)
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})
