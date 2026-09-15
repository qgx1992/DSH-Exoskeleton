// titlebar-overlay 契约测试（Electron 环境：探针脚本需真实 DOM/CSS 求值）
// 覆盖：
//   1. normalizeCssColor：hex/rgb 归一化，半透明与非法值返回 null（不误当实底）
//   2. pickSymbolColor：暗底给浅笔画、亮底给深笔画，且对比度均达 WCAG AA(4.5)
//   3. buildTopColorProbeScript：真实页面里取到「被画出来的」顶栏底色，
//      且**不受半透明祖先干扰**（上溯到第一个不透明背景）
//   4. buildTopColorProbeScript：亮/暗主题下取到各自颜色
//   5. buildThemeWatchScript：改 body[data-ds-dark-theme] 后经 __dshExo 回壳
//   6. 空页面/异常时返回 color=null 而不抛（调用方保留上一次颜色）
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..', '..')
const tmpRoot = path.join(os.tmpdir(), 'dsh-titlebar-overlay-test-' + Date.now())
app.setPath('userData', path.join(tmpRoot, 'userdata'))

/** 用 esbuild 现场编译 TS 模块（electron 下 process.execPath 是 electron.exe，不能当 node 用） */
function loadModule() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `titlebar-overlay-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'titlebar-overlay.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'error'
  })
  return require(out)
}

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label, detail !== undefined ? '— ' + JSON.stringify(detail) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  try {
    const mod = loadModule()
    const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')

    console.log('1) normalizeCssColor')
    assert(mod.normalizeCssColor('rgb(21, 21, 23)') === '#151517', 'rgb → hex', mod.normalizeCssColor('rgb(21, 21, 23)'))
    assert(mod.normalizeCssColor('#FFF') === '#ffffff', '#FFF → #ffffff', mod.normalizeCssColor('#FFF'))
    assert(mod.normalizeCssColor('#0B0F17') === '#0b0f17', '大写 hex 归一化为小写', mod.normalizeCssColor('#0B0F17'))
    assert(mod.normalizeCssColor('rgba(0, 0, 0, 0)') === null, '全透明 → null（继续上溯）', mod.normalizeCssColor('rgba(0, 0, 0, 0)'))
    assert(mod.normalizeCssColor('rgba(21, 21, 23, 0.5)') === null, '半透明 → null', mod.normalizeCssColor('rgba(21, 21, 23, 0.5)'))
    assert(mod.normalizeCssColor('#15151780') === null, '8 位 hex 半透明 → null', mod.normalizeCssColor('#15151780'))
    assert(mod.normalizeCssColor('') === null && mod.normalizeCssColor(undefined) === null && mod.normalizeCssColor('not-a-color') === null, '空/非字符串/垃圾 → null')
    assert(mod.normalizeCssColor('rgb(100%, 100%, 100%)') === '#ffffff', '百分比 rgb → hex', mod.normalizeCssColor('rgb(100%, 100%, 100%)'))
    assert(mod.normalizeCssColor('rgba(21, 21, 23, 1)') === '#151517', 'alpha=1 视为不透明', mod.normalizeCssColor('rgba(21, 21, 23, 1)'))

    console.log('2) pickSymbolColor（对比度）')
    const darkBg = '#151517'
    const lightBg = '#ffffff'
    const symOnDark = mod.pickSymbolColor(darkBg)
    const symOnLight = mod.pickSymbolColor(lightBg)
    assert(symOnDark === '#f9fafb', '暗底 → 浅笔画 #f9fafb', symOnDark)
    assert(symOnLight === '#0f1115', '亮底 → 深笔画 #0f1115', symOnLight)
    const cDark = mod.contrastRatio(darkBg, symOnDark)
    const cLight = mod.contrastRatio(lightBg, symOnLight)
    assert(cDark >= 4.5, `暗底对比度 ≥ 4.5（实测 ${cDark.toFixed(2)}）`, cDark)
    assert(cLight >= 4.5, `亮底对比度 ≥ 4.5（实测 ${cLight.toFixed(2)}）`, cLight)
    // 底色异常（黑/白极端）也必须给出可用笔画
    assert(mod.contrastRatio('#000000', mod.pickSymbolColor('#000000')) >= 4.5, '纯黑底仍可辨')
    assert(mod.contrastRatio('#ffffff', mod.pickSymbolColor('#ffffff')) >= 4.5, '纯白底仍可辨')

    console.log('3-5) 探针 / 主题观察（真实页面）')
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const received = []
    win.webContents.on('ipc-message', (_e, channel, ...args) => {
      if (channel === 'dsh-exo') received.push({ channel: args[0], payload: args[1] })
    })

    // 模拟 DSH 顶栏：root 有不透明底色，中间夹半透明层（回归：不能取到 rgba(0,0,0,0)）
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><style>
      html,body{margin:0;height:100%}
      body{background:#151517}
      #frame{height:100%;background:#151517}
      #center{height:100%;background:transparent}
    </style></head><body>
      <div id="frame"><div id="center"><div style="position:absolute;right:0;top:0;width:200px;height:36px;background:transparent">顶部右区</div></div></div>
    </body></html>`))
    await sleep(300)

    const probe = mod.buildTopColorProbeScript(36)
    const r1 = await win.webContents.executeJavaScript(probe)
    assert(r1 && r1.color === '#151517', '探针取到不透明顶栏底色 #151517（穿透半透明层）', r1)
    assert(r1 && Array.isArray(r1.samples) && r1.samples.length > 0 && r1.samples.every((s) => s === '#151517'), '全部采样点一致', r1 && r1.samples)

    // 亮色主题：换 body 底色 + 打上 DSH 暗色标记
    await win.webContents.executeJavaScript(`document.body.style.background = '#ffffff'; document.getElementById('frame').style.background = '#ffffff'; true`)
    await sleep(200)
    const r2 = await win.webContents.executeJavaScript(probe)
    assert(r2 && r2.color === '#ffffff', '亮底顶栏取到 #ffffff', r2)
    assert(r2 && r2.dark === false, '无 data-ds-dark-theme → dark=false', r2 && r2.dark)

    // 令牌兜底：元素层透明时回退 --dsw-alias-bg-base
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><style>
      html,body{margin:0;height:100%;background:transparent}
      :root{--dsw-alias-bg-base:#2c2c2e}
    </style></head><body></body></html>`))
    await sleep(300)
    const r3 = await win.webContents.executeJavaScript(probe)
    assert(r3 && r3.color === '#2c2c2e' && r3.source === 'token', '元素全透明 → 回退官方令牌', r3)

    // 空白页（连 body 背景都没有）→ color=null，不抛
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><style>html,body{margin:0;height:100%;background:transparent}</style></head><body></body></html>`))
    await sleep(300)
    const r4 = await win.webContents.executeJavaScript(probe)
    assert(r4 && r4.color === null, '取不到色 → color=null（调用方保留旧色）', r4)

    // 主题观察：改属性 → 经 __dshExo 回壳
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body style="background:#151517">theme</body></html>'))
    await sleep(300)
    const watch = await win.webContents.executeJavaScript(mod.buildThemeWatchScript())
    assert(watch === 'installed', '主题观察脚本注入成功', watch)
    const again = await win.webContents.executeJavaScript(mod.buildThemeWatchScript())
    assert(again === 'already', '重复注入为幂等（already）', again)

    await win.webContents.executeJavaScript(`document.body.setAttribute('data-ds-dark-theme',''); true`)
    await sleep(500)
    const themeMsgs = received.filter((m) => m.channel === mod.THEME_CHANGED_CHANNEL)
    assert(themeMsgs.length >= 1, '主题变更经 __dshExo 回壳', received)
    assert(themeMsgs.length >= 1 && themeMsgs[themeMsgs.length - 1].payload && themeMsgs[themeMsgs.length - 1].payload.dark === true, '载荷带 dark=true', themeMsgs[themeMsgs.length - 1])

    await win.webContents.executeJavaScript(`document.body.removeAttribute('data-ds-dark-theme'); true`)
    await sleep(500)
    const themeMsgs2 = received.filter((m) => m.channel === mod.THEME_CHANGED_CHANNEL)
    assert(themeMsgs2.length >= 2 && themeMsgs2[themeMsgs2.length - 1].payload.dark === false, '移除属性 → dark=false', themeMsgs2[themeMsgs2.length - 1])

    console.log('6) 常量一致性')
    // 壳画布色必须与 renderer 的 --color-canvas 一致（否则管理面板态仍有色缝）
    const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'global.css'), 'utf-8')
    // 两种写法都要认：源码写 oklch(0.148 …)，构建产物被 Tailwind 归一成 oklch(14.8% …)
    const m = css.match(/--color-canvas:\s*oklch\(([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\)/)
    assert(!!m, 'global.css 存在 --color-canvas')
    if (m) {
      const L = m[2] === '%' ? parseFloat(m[1]) / 100 : parseFloat(m[1])
      const C = parseFloat(m[3])
      const H = parseFloat(m[4])
      const h = (H * Math.PI) / 180
      const a = C * Math.cos(h)
      const b = C * Math.sin(h)
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
      const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
      const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
      const f = (x) => {
        const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
        return Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
      }
      const hex = '#' + [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s].map(f).join('')
      assert(hex === mod.SHELL_CANVAS_COLOR.toLowerCase(), `SHELL_CANVAS_COLOR (${mod.SHELL_CANVAS_COLOR}) 与 --color-canvas (${hex}) 一致`, { css: hex, main: mod.SHELL_CANVAS_COLOR })
    }
    assert(mod.normalizeCssColor(mod.DSH_TOP_COLOR_DARK) === '#151517', 'DSH 暗色兜底值 = 实测 #151517', mod.DSH_TOP_COLOR_DARK)
    assert(mod.normalizeCssColor(mod.DSH_TOP_COLOR_LIGHT) === '#ffffff', 'DSH 亮色兜底值 = 实测 #ffffff', mod.DSH_TOP_COLOR_LIGHT)

    win.destroy()
  } catch (e) {
    console.error('TEST CRASH:', e)
    failed++
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy() } catch (_) { /* noop */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (err) { console.warn('cleanup skipped (EPERM):', String(err)) }
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    app.exit(failed === 0 ? 0 : 1)
  }
})
