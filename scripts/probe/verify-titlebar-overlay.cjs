/**
 * 端到端验证：右上角原生窗口按钮（titleBarOverlay）底色与页面顶栏是否已对齐。
 *
 * ⚠️ 关键方法学：**不能用 capturePage**。capturePage 只抓 WebContents 自己的像素，
 * 原生 overlay 由系统画在内容之上、不进 web 图层——用它比对「带内 vs 带外」等于拿页面
 * 比自己，必然 Δ=0，是个假通过。故本用例走**桌面级 GDI 截屏**抓窗口矩形（物理像素），
 * 这是唯一能看见原生 overlay 真实颜色的路径（同 probe-overlay-buttons-shot.cjs 口径）。
 *
 * 实测事实（probe-overlay-color.cjs）：Windows 下 overlay 只画在**按钮簇矩形**上
 * （约最右 138 DIP × 36 DIP），不是整条顶栏——所以那条色缝就是按钮底下那块矩形。
 *
 * 判据：
 *   ① 按钮簇背景色 == 其正下方页面底色（ΔRGB=0 → 无色缝）
 *   ② 对照实验：把 color 换回旧硬编码值 #0b0f17，簇背景必须**变得不同**（证明用例有鉴别力）
 *   ③ 亮色主题下同样对齐（证明跟着 DSH 主题换色）
 *   ④ 按钮笔画在簇底色上可辨（对比度 ≥ 4.5）
 *   ⑤ 窗口高 == 内容高（无系统标题栏/菜单）
 */
const { app, BrowserWindow, Menu, WebContentsView, screen } = require('electron')
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')
/** 本次改动前的硬编码值（对照实验用） */
const LEGACY_COLOR = '#0b0f17'
const OVERLAY_H = 36
/** Windows 按钮簇宽度（DIP）：实测 #0B0F17 区域从右边缘向左约 137~138px */
const CLUSTER_W = 138

let passed = 0
let failed = 0
const assert = (cond, label, detail) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label, detail !== undefined ? ' — ' + JSON.stringify(detail) : '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadOverlayModule() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const out = path.join(os.tmpdir(), `tbo-verify-${Date.now()}.cjs`)
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'titlebar-overlay.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error'
  })
  return require(out)
}

/** 桌面级截屏（GDI，物理像素） */
function grabScreen(x, y, w, h, outFile) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)
$bmp.Save('${outFile.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output 'ok'
`
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' }).toString()
}

const maxDelta = (a, b) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const x = p(a); const y = p(b)
  return Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]))
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const mod = loadOverlayModule()

  const log = path.join(app.getPath('temp'), 'verify-titlebar-overlay.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  const child = spawn(process.env.DSH_PROBE_NODE || 'node', [KERNEL_BIN, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    stdio: ['ignore', fd, fd], windowsHide: true
  })
  let url = null
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      const m = fs.readFileSync(log, 'utf-8').match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\S*)/)
      if (m) { url = m[1]; break }
    } catch { /* noop */ }
  }
  if (!url) { console.error('内核未就绪'); app.exit(1); return }
  console.log('kernel url =', url)

  const win = new BrowserWindow({
    show: true, width: 1440, height: 900, x: 80, y: 60,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: mod.SHELL_CANVAS_COLOR,
      symbolColor: mod.pickSymbolColor(mod.SHELL_CANVAS_COLOR),
      height: OVERLAY_H
    },
    backgroundColor: mod.SHELL_CANVAS_COLOR
  })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  const [cw, ch] = win.getContentSize()
  view.setBounds({ x: 0, y: 0, width: cw, height: ch })
  await view.webContents.loadURL(url)
  await sleep(9000)
  win.focus()
  win.moveTop()
  await sleep(600)

  const scale = screen.getPrimaryDisplay().scaleFactor

  /** 桌面截屏 + 解析 PNG，返回取色函数 */
  function shoot() {
    const b = win.getBounds()
    const px = Math.round(b.x * scale)
    const py = Math.round(b.y * scale)
    const pw = Math.round(b.width * scale)
    const ph = Math.min(Math.round(90 * scale), Math.round(b.height * scale))
    const out = path.join(os.tmpdir(), `tbo-shot-${Date.now()}.png`)
    grabScreen(px, py, pw, ph, out)
    return { file: out, w: pw, h: ph, bounds: b }
  }

  /** 用 Electron 自带 nativeImage 读 PNG 取色（避免额外依赖） */
  function sample(shotFile, points) {
    const img = require('electron').nativeImage.createFromPath(shotFile)
    const size = img.getSize()
    const bmp = img.toBitmap()
    const res = []
    for (const [x, y] of points) {
      const xi = Math.max(0, Math.min(size.width - 1, Math.round(x)))
      const yi = Math.max(0, Math.min(size.height - 1, Math.round(y)))
      const i = (yi * size.width + xi) * 4
      res.push('#' + [bmp[i + 2], bmp[i + 1], bmp[i]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase())
    }
    return { colors: res, size }
  }

  /** 统一测量：应用某 overlay 色 → 桌面截屏 → 读簇背景与簇下方页面色 */
  async function measure(theme, colorToApply) {
    // 切主题（与 window-manager 收到的页面信号同口径）
    await view.webContents.executeJavaScript(`(() => {
      const b = document.body
      if (${theme === 'dark'}) b.setAttribute('data-ds-dark-theme', '')
      else b.removeAttribute('data-ds-dark-theme')
      return true
    })()`)
    await sleep(700)

    // 与 window-manager 同路径：探针取页面顶栏色
    const probe = await view.webContents.executeJavaScript(mod.buildTopColorProbeScript(OVERLAY_H))
    const pageColor = mod.normalizeCssColor(probe && probe.color)
    const apply = colorToApply === 'legacy' ? LEGACY_COLOR : pageColor
    win.setTitleBarOverlay({ color: apply, symbolColor: mod.pickSymbolColor(apply), height: OVERLAY_H })
    win.focus()
    await sleep(900)

    const shot = shoot()
    const s = scale
    // 簇左内边缘（避开圆角与画笔）：右边缘向左 CLUSTER_W-12 DIP
    const clusterX = shot.w - (CLUSTER_W - 12) * s
    const midY = Math.round((OVERLAY_H / 2) * s)
    const belowY = Math.round((OVERLAY_H + 8) * s)
    // 横向多采几点（都在簇内的空白处）取众数，抗画笔干扰
    const xs = [CLUSTER_W - 12, CLUSTER_W - 30, CLUSTER_W - 80].map((d) => shot.w - d * s)
    const cluster = sample(shot.file, xs.map((x) => [x, midY])).colors
    // 簇正下方的页面底色（同一批 x）
    const below = sample(shot.file, xs.map((x) => [x, belowY])).colors
    const mode = (arr) => {
      const t = new Map()
      for (const v of arr) t.set(v, (t.get(v) || 0) + 1)
      let best = arr[0]; let bn = 0
      for (const v of arr) { const n = t.get(v); if (n > bn) { best = v; bn = n } }
      return best
    }
    return {
      theme,
      probeSource: probe && probe.source,
      pageColor,
      applied: apply,
      clusterSamples: cluster,
      belowSamples: below,
      clusterMode: mode(cluster),
      belowMode: mode(below),
      shot: shot.file
    }
  }

  console.log('\n=================== 端到端结果（桌面级像素） ===================')
  const darkFixed = await measure('dark', 'auto')
  const lightFixed = await measure('light', 'auto')
  // 对照实验：暗色主题下故意用旧硬编码色，验证用例真能发现旧 bug
  const darkLegacy = await measure('dark', 'legacy')
  // 复原为修复态
  const darkFixed2 = await measure('dark', 'auto')

  for (const r of [darkFixed, lightFixed, darkLegacy, darkFixed2]) {
    const tag = r.applied === LEGACY_COLOR ? '对照·旧值' : '修复态'
    console.log(`\n----- ${r.theme} / ${tag} (探针 ${r.probeSource}) -----`)
    console.log('  探针取页面顶栏色 :', r.pageColor)
    console.log('  实际下发 overlay :', r.applied)
    console.log('  按钮簇背景采样   :', JSON.stringify(r.clusterSamples), '→ 众数', r.clusterMode)
    console.log('  簇下方页面采样   :', JSON.stringify(r.belowSamples), '→ 众数', r.belowMode)
    console.log('  色差 Δ           :', maxDelta(r.clusterMode, r.belowMode))
  }

  console.log('\n--- 断言 ---')
  // ① 修复态：暗色
  assert(darkFixed.clusterMode === darkFixed.belowMode,
    `[暗色·修复态] 按钮簇背景 == 页面底色（${darkFixed.clusterMode}）`,
    { cluster: darkFixed.clusterMode, below: darkFixed.belowMode })
  assert(maxDelta(darkFixed.clusterMode, darkFixed.belowMode) === 0, '[暗色·修复态] 色差 0（无色缝）')
  // ② 对照：旧值必须不同 → 证明用例有鉴别力
  assert(maxDelta(darkLegacy.clusterMode, darkLegacy.belowMode) > 0,
    `[暗色·对照旧值] 旧值 ${LEGACY_COLOR} 与页面底色不同（用例有鉴别力，Δ=${maxDelta(darkLegacy.clusterMode, darkLegacy.belowMode)}）`,
    { cluster: darkLegacy.clusterMode, below: darkLegacy.belowMode })
  assert(darkLegacy.clusterMode.toLowerCase() === LEGACY_COLOR.toLowerCase(), `[暗色·对照旧值] 簇背景确实是旧值 ${LEGACY_COLOR}（证明采样点打在簇上）`, darkLegacy.clusterMode)
  // ③ 亮色：跟着换白
  assert(lightFixed.clusterMode === lightFixed.belowMode,
    `[亮色·修复态] 按钮簇背景 == 页面底色（${lightFixed.clusterMode}）`,
    { cluster: lightFixed.clusterMode, below: lightFixed.belowMode })
  assert(maxDelta(lightFixed.belowMode, darkFixed.belowMode) > 0, '[主题跟随] 亮/暗页面底色确实不同（主题跟随有意义）', { dark: darkFixed.belowMode, light: lightFixed.belowMode })
  // ④ 笔画可辨
  const cDark = mod.contrastRatio(darkFixed.belowMode, mod.pickSymbolColor(darkFixed.belowMode))
  const cLight = mod.contrastRatio(lightFixed.belowMode, mod.pickSymbolColor(lightFixed.belowMode))
  assert(cDark >= 4.5, `[暗色] 按钮笔画可辨（对比度 ${cDark.toFixed(2)}）`)
  assert(cLight >= 4.5, `[亮色] 按钮笔画可辨（对比度 ${cLight.toFixed(2)}）`)
  // ⑤ 无标题栏
  const wb = win.getBounds(); const cb = win.getContentBounds()
  assert(wb.height - cb.height === 0, '窗口高 == 内容高（无系统标题栏/菜单）', { window: wb.height, content: cb.height })

  try { fs.copyFileSync(darkFixed.shot, path.join(os.tmpdir(), 'verify-tbo-dark.png')) } catch { /* noop */ }
  try { fs.copyFileSync(lightFixed.shot, path.join(os.tmpdir(), 'verify-tbo-light.png')) } catch { /* noop */ }
  console.log('\nSHOT(dark) =', darkFixed.shot)
  console.log('SHOT(light)=', lightFixed.shot)

  try { child.kill() } catch { /* noop */ }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  app.exit(failed === 0 ? 0 : 1)
})
