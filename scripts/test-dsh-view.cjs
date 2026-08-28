// dsh-view preload（window.__dshExo）契约集成测试（Electron 沙箱环境）
// 覆盖（设计 NOTIFICATION-PLUGIN-DESIGN.md §5 / §5.3，P4 review 修正）：
//  1. sandbox + contextIsolation 下 preload 可加载，window.__dshExo 暴露
//     onEvent / send / ready / appInfo 四个白名单方法
//  2. 主 → 页面：webContents.send('dsh-notify:event', ev) 到达页面 onEvent 回调
//  3. 页面 → 主：send('notify:click'/'notify:install'/'notify:ready') 经
//     'dsh-exo' 通道到达主进程（ipc-message），载荷透传
//  4. R-27：页面只看到 __dshExo，无 dshDesktop 等管理桥；appInfo 不带版本信息
//     （P4：不再经 ipcRenderer.invoke('app:getVersion') 取版本，页面不可达管理 IPC）
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const tmpRoot = path.join(os.tmpdir(), 'dsh-view-test-' + Date.now())
app.setPath('userData', path.join(tmpRoot, 'userdata'))

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label, detail !== undefined ? '— ' + JSON.stringify(detail) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  try {
    const preload = path.join(__dirname, 'out', 'dsh-view.cjs')
    if (!fs.existsSync(preload)) throw new Error('preload bundle missing: ' + preload)

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    // 主进程侧接收页面 send（dsh-exo）
    const received = []
    win.webContents.on('ipc-message', (_e, channel, ...args) => {
      if (channel === 'dsh-exo') received.push({ channel: args[0], payload: args[1] })
    })

    await win.loadURL('data:text/html,<html><body>dsh-view test</body></html>')

    console.log('1) 桥形状（sandbox preload 可加载）')
    const shape = await win.webContents.executeJavaScript(`(() => {
      const b = window.__dshExo
      return {
        has: !!b,
        types: b ? { onEvent: typeof b.onEvent, send: typeof b.send, ready: typeof b.ready, appInfo: typeof b.appInfo } : null
      }
    })()`)
    assert(shape.has, 'window.__dshExo 存在')
    assert(
      shape.types && shape.types.onEvent === 'function' && shape.types.send === 'function' && shape.types.ready === 'function' && shape.types.appInfo === 'function',
      '__dshExo 暴露 onEvent/send/ready/appInfo',
      shape.types
    )
    const info = await win.webContents.executeJavaScript(`window.__dshExo.appInfo()`)
    assert(info && typeof info.version === 'string', 'appInfo 契约形状（version 字符串）', info)

    console.log('2) 主 → 页面：onEvent 回环')
    // 注意：① 回调里的 ev 是 contextBridge 跨世界 Proxy，executeJavaScript 回传无法克隆它，
    //        因此只取标量字段存回 window（生产环境插件同样只读标量，不受影响）；
    //       ② onEvent 返回卸载函数（contextBridge Proxy），脚本末尾必须 void 0，
    //         否则 executeJavaScript 把该函数当返回值克隆 → "An object could not be cloned"
    await win.webContents.executeJavaScript(`window.__got = null; window.__dshExo.onEvent((ev) => { window.__got = { id: ev.id, kind: ev.kind } }); void 0`)
    win.webContents.send('dsh-notify:event', { id: 'ev-r1', kind: 'service-ready', title: 'T', body: 'B', ts: 1 })
    await sleep(300)
    const got = await win.webContents.executeJavaScript(`window.__got`)
    assert(got && got.id === 'ev-r1' && got.kind === 'service-ready', '主推送事件到达页面回调', got)

    console.log('3) 页面 → 主：send 回环（click / install / ready）')
    await win.webContents.executeJavaScript(`window.__dshExo.send('notify:click', { id: 'ev-r2', sessionId: 'session-xyz' })`)
    await win.webContents.executeJavaScript(`window.__dshExo.send('notify:install', { id: 'ev-r3' })`)
    await win.webContents.executeJavaScript(`window.__dshExo.ready()`)
    await sleep(300)
    assert(received.length === 3, '主进程收到 3 条 dsh-exo 消息', received.length)
    assert(received[0] && received[0].channel === 'notify:click' && received[0].payload.sessionId === 'session-xyz', 'notify:click 载荷透传', received[0])
    assert(received[1] && received[1].channel === 'notify:install', 'notify:install 通道可达', received[1])
    assert(received[2] && received[2].channel === 'notify:ready', 'notify:ready 握手可达', received[2])

    console.log('4) R-27：仅暴露 __dshExo，无管理桥')
    const keys = await win.webContents.executeJavaScript(`Object.keys(window).filter((k) => k === '__dshExo' || k === 'dshDesktop')`)
    assert(keys.length === 1 && keys[0] === '__dshExo', '仅 __dshExo（无 dshDesktop 等管理桥）', keys)

    win.destroy()
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy() } catch (_) {}
    // Chromium 缓存文件可能仍被占用（EPERM）；清理失败不吞退出码，仅告警
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (err) { console.warn('cleanup skipped (EPERM):', String(err)) }
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})
