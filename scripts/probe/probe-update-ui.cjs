// 实机 UI 探针：在真实 Electron 渲染进程里加载构建后的管理面板，
// 验证「更新」页两个开关确实渲染出来、且点击后发出正确的 config.set → IPC 载荷。
//
// 为什么需要它：主进程单测只能证明 updater 的开关逻辑对，证明不了
// 「UI 有没有渲染/点了传的值对不对/disabled 态是否卡死」——那是另一半链路。
// 这里用 preload 桩掉 window.dshDesktop，把渲染进程真实跑起来，记录 IPC 调用。
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = path.join(os.tmpdir(), 'dsh-update-ui-' + Date.now())
app.setPath('userData', path.join(tmpRoot, 'userdata'))
app.setName('DshUpdateUiProbe')

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label, detail !== undefined ? ' — ' + JSON.stringify(detail) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 桩 preload：把渲染进程需要的 window.dshDesktop 换成可观测替身。
// 独立成文件（scripts/probe/stub-preload.cjs）而非内联字符串：命名空间多，内联难维护。
fs.mkdirSync(tmpRoot, { recursive: true })
const stubPreload = path.resolve(__dirname, 'stub-preload.cjs')

app.whenReady().then(async () => {
  let win = null
  // 页面错误必须在主进程侧收集：contextIsolation=true 下 preload 的 window 与页面主世界
  // 互相隔离，preload 里 addEventListener('error') 根本收不到页面抛的错（实测已验证），
  // 写成那样会让「无 JS 错误」变成永远为真的假绿断言。
  const pageErrors = []
  try {
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 820,
      webPreferences: { preload: stubPreload, sandbox: false, contextIsolation: true }
    })
    win.webContents.on('console-message', (_e, level, message) => {
      // level 3 = error（Electron 枚举：0 verbose / 1 info / 2 warning / 3 error）
      if (level === 3) pageErrors.push(String(message))
    })
    const indexPath = path.resolve(__dirname, '../../out/renderer/index.html')
    await win.loadFile(indexPath)
    await sleep(600) // 等 React 挂载 + config.get 异步返回

    const run = (code) => win.webContents.executeJavaScript(code, true)

    console.log('0) 渲染进程已加载，桩 API 生效')
    assert(await run(`typeof window.dshDesktop === 'object'`), 'window.dshDesktop 桩已注入')

    console.log('1) 切到「更新」页')
    const switched = await run(`(() => {
      const btns = [...document.querySelectorAll('button')]
      const t = btns.find(b => b.textContent.trim() === '更新')
      if (!t) return 'tab-not-found'
      t.click()
      return 'ok'
    })()`)
    assert(switched === 'ok', '找到并点击「更新」tab', switched)
    await sleep(400)

    console.log('2) 两个开关都渲染出来（role=switch + aria-label）')
    const switches = await run(`[...document.querySelectorAll('button[role="switch"]')].map(b => b.getAttribute('aria-label'))`)
    assert(Array.isArray(switches) && switches.includes('自动检查更新'), '渲染出「自动检查更新」开关', switches)
    assert(Array.isArray(switches) && switches.includes('自动下载更新'), '渲染出「自动下载更新」开关', switches)
    assert(switches.length === 2, '该页恰好两个开关（无多余/重复）', switches.length)

    console.log('3) 初始状态与配置一致（均开），且未加载完不会 disabled 卡死')
    const states = await run(`[...document.querySelectorAll('button[role="switch"]')].map(b => ({ label: b.getAttribute('aria-label'), checked: b.getAttribute('aria-checked'), disabled: b.disabled }))`)
    const chk = states.find((s) => s.label === '自动检查更新')
    const dld = states.find((s) => s.label === '自动下载更新')
    assert(chk && chk.checked === 'true', '「自动检查更新」初始为开', chk)
    assert(dld && dld.checked === 'true', '「自动下载更新」初始为开', dld)
    assert(chk && chk.disabled === false, '配置加载完成后开关可用（非 disabled）', chk)

    console.log('4) 点「自动下载更新」→ 只发 autoDownloadUpdate（不误伤检查开关）')
    await run(`(() => {
      const b = [...document.querySelectorAll('button[role="switch"]')].find(x => x.getAttribute('aria-label') === '自动下载更新')
      b.click()
    })()`)
    await sleep(300)
    const calls1 = await run(`window.dshDesktop.__calls()`)
    const setCalls1 = calls1.filter((c) => c[0] === 'config.set')
    assert(setCalls1.length === 1, '点一次只发一次 config.set', setCalls1)
    assert(setCalls1[0] && setCalls1[0][1] && setCalls1[0][1].autoDownloadUpdate === false, '载荷为 { autoDownloadUpdate: false }', setCalls1[0] && setCalls1[0][1])
    assert(setCalls1[0] && setCalls1[0][1].autoCheckUpdate === undefined, '载荷不含 autoCheckUpdate（两个开关互不干扰）', setCalls1[0] && setCalls1[0][1])
    const afterDown = await run(`[...document.querySelectorAll('button[role="switch"]')].map(b => ({ l: b.getAttribute('aria-label'), c: b.getAttribute('aria-checked') }))`)
    assert(afterDown.find((s) => s.l === '自动下载更新').c === 'false', '开关视觉状态已变为关', afterDown)
    assert(afterDown.find((s) => s.l === '自动检查更新').c === 'true', '检查开关不受影响（仍为开）', afterDown)

    console.log('5) 关闭下载时给出说明文案（用户知道接下来要手动点下载）')
    const hint = await run(`document.body.innerText.includes('已关闭自动下载')`)
    assert(hint === true, '渲染「已关闭自动下载」提示文案')

    console.log('6) 点「自动检查更新」→ 只发 autoCheckUpdate')
    await run(`(() => {
      const b = [...document.querySelectorAll('button[role="switch"]')].find(x => x.getAttribute('aria-label') === '自动检查更新')
      b.click()
    })()`)
    await sleep(300)
    const calls2 = await run(`window.dshDesktop.__calls()`)
    const setCalls2 = calls2.filter((c) => c[0] === 'config.set')
    assert(setCalls2.length === 2, '累计两次 config.set', setCalls2.length)
    assert(setCalls2[1][1].autoCheckUpdate === false, '第二次载荷为 { autoCheckUpdate: false }', setCalls2[1][1])
    assert(setCalls2[1][1].autoDownloadUpdate === undefined, '第二次载荷不含 autoDownloadUpdate', setCalls2[1][1])

    console.log('7) 点「检查更新」→ 走 updater.check，并渲染出「下载更新」按钮（autoUpdateSupported=true）')
    await run(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('检查更新'))
      b.click()
    })()`)
    await sleep(400)
    const calls3 = await run(`window.dshDesktop.__calls()`)
    assert(calls3.some((c) => c[0] === 'updater.check'), '点击触发 updater.check', calls3.filter((c) => c[0].startsWith('updater')))
    const hasDownloadBtn = await run(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '下载更新')`)
    assert(hasDownloadBtn === true, '安装版（autoUpdateSupported=true）渲染「下载更新」按钮')

    console.log('8) autoUpdateSupported=false（便携版）→ 不渲染「下载更新」按钮，只留下载页入口')
    await run(`window.dshDesktop.__setInfo({ current:'0.9.5', latest:'0.9.9', available:true, url:'https://example.invalid/rel', checkedAt: Date.now(), error:null, progress:null, downloaded:false, installing:false, autoUpdateSupported:false })`)
    // 重新点检查以把新 UpdateInfo 灌进组件状态
    await run(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('检查更新'))
      b.click()
    })()`)
    await sleep(400)
    const hasDownloadBtn2 = await run(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '下载更新')`)
    const hasPageBtn = await run(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('前往下载页'))`)
    assert(hasDownloadBtn2 === false, '便携版不渲染「下载更新」按钮（避免点了只报错的入口）')
    assert(hasPageBtn === true, '便携版仍提供「前往下载页」入口')

    console.log('9) 页面无 JS 错误（主进程 console-message 收集，带自检防假绿）')
    // 自检：先故意抛一个错，确认收集器真的能收到——否则这条断言可能恒真
    await win.webContents.executeJavaScript(`setTimeout(() => { throw new Error('probe-selfcheck-sentinel') }, 0)`, true)
    await sleep(300)
    assert(
      pageErrors.some((m) => m.includes('probe-selfcheck-sentinel')),
      '自检：故意抛错能被收集到（证明该断言不是假绿）',
      pageErrors
    )
    const realErrors = pageErrors.filter((m) => !m.includes('probe-selfcheck-sentinel'))
    assert(realErrors.length === 0, '真实页面无 JS 错误', realErrors)
  } catch (e) {
    console.error('PROBE CRASH:', e)
    failed++
  } finally {
    if (win) win.destroy()
    // Electron 退出前仍在写 Cache 目录，同步删会 EPERM 噪音（不影响断言，但污染输出）
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 忽略：临时目录，系统会回收 */ }
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})
