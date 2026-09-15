/**
 * 取证：右上角原生窗口按钮（titleBarOverlay）底下那一层到底是什么颜色。
 *
 * 目的：为「overlay color 该取哪个值」提供实测依据，而不是猜。
 * 采样三路：
 *   ① 真机像素：capturePage 抓 overlay 覆盖区（右上角 140x36），读实际像素色
 *   ② DOM 命中：elementFromPoint 在 overlay 带内取元素并向祖先回溯背景色链
 *   ③ 设计令牌：body / :root 上的 --dsw-alias-bg-base、--color-canvas 等解析值
 * 并分别在暗色 / 亮色主题下各采一次（亮色用于确认 symbolColor 也要跟着变）。
 */
const { app, BrowserWindow, Menu, WebContentsView } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })

const ROOT = path.resolve(__dirname, '..', '..')
const KERNEL_BIN = 'C:/Users/qq817/AppData/Roaming/DSH-Exoskeleton/kernels/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PRELOAD = path.join(ROOT, 'out', 'preload', 'dsh-view.js')
const OVERLAY_H = 36
const PROBE_W = 140

/** 页面上取色的脚本（解析 body/:root 令牌 + overlay 带内命中链） */
const SAMPLE_SCRIPT = `(() => {
  const hex = (rgb) => {
    const m = String(rgb).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    if (p.length > 3 && p[3] === 0) return null;            // 全透明
    const hasFrac = p.some(v => !Number.isInteger(v));       // color-mix 会产出小数
    return '#' + p.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase() + (hasFrac ? '~' : '');
  };
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const bodyCs = cs(document.body);
  const rootCs = cs(document.documentElement);
  const readVar = (name) => {
    for (const c of [bodyCs, rootCs]) {
      if (!c) continue;
      const v = c.getPropertyValue(name).trim();
      if (v) return v;
    }
    return '';
  };
  // overlay 带内命中：x 靠右内边缘、y 取带中线（原生按钮不是 DOM，不影响命中）
  const x = window.innerWidth - 6;
  const y = Math.round(${OVERLAY_H} / 2);
  const chain = [];
  let el = document.elementFromPoint(x, y);
  for (let i = 0; el && i < 10; i++, el = el.parentElement) {
    const c = cs(el);
    if (!c) break;
    chain.push({
      tag: el.tagName + (el.id ? '#' + el.id : ''),
      cls: String(el.className || '').slice(0, 48),
      color: c.backgroundColor,
      colorHex: hex(c.backgroundColor),
      image: c.backgroundImage && c.backgroundImage !== 'none' ? c.backgroundImage.slice(0, 60) : null
    });
  }
  return {
    href: location.href,
    innerWidth: window.innerWidth,
    dark: document.body.hasAttribute('data-ds-dark-theme') || document.documentElement.hasAttribute('data-ds-dark-theme'),
    domDarkAttr: document.body.getAttribute('data-ds-dark-theme') !== null,
    bodyBg: hex(bodyCs.backgroundColor),
    bodyBgRaw: bodyCs.backgroundColor,
    rootBg: hex(rootCs.backgroundColor),
    rootBgRaw: rootCs.backgroundColor,
    tokens: {
      dswBgBase: readVar('--dsw-alias-bg-base'),
      dswBgLayer1: readVar('--dsw-alias-bg-layer-1'),
      dswLabelPrimary: readVar('--dsw-alias-label-primary'),
      colorCanvas: readVar('--color-canvas'),
      colorSurface: readVar('--color-surface'),
      colorInk: readVar('--color-ink')
    },
    chain
  };
})()`

/** 从 nativeImage 取指定像素（BGRA） */
function px(img, x, y) {
  const bmp = img.toBitmap()
  const w = img.getSize().width
  const i = (y * w + x) * 4
  return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2], a: bmp[i + 3] }
}
const toHex = (p) => '#' + [p.r, p.g, p.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)

  const log = path.join(app.getPath('temp'), 'probe-overlay-color.log')
  fs.rmSync(log, { force: true })
  const fd = fs.openSync(log, 'w')
  const child = spawn(process.env.DSH_PROBE_NODE || 'node', [KERNEL_BIN, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    stdio: ['ignore', fd, fd], windowsHide: true
  })

  let url = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const m = fs.readFileSync(log, 'utf-8').match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\S*)/)
      if (m) { url = m[1]; break }
    } catch { /* noop */ }
  }
  if (!url) { console.error('内核未就绪'); app.exit(1); return }
  console.log('kernel url =', url)

  // 当前实现用的 overlay 色，作为对照
  const win = new BrowserWindow({
    show: true, width: 1440, height: 900, x: 60, y: 60,
    backgroundColor: '#0b0f17',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0f17', symbolColor: '#c9d1d9', height: OVERLAY_H }
  })
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD }
  })
  win.contentView.addChildView(view)
  const [cw, ch] = win.getContentSize()
  view.setBounds({ x: 0, y: 0, width: cw, height: ch })
  await view.webContents.loadURL(url)
  await new Promise((r) => setTimeout(r, 9000))

  const report = {}
  for (const theme of ['dark', 'light']) {
    await view.webContents.executeJavaScript(`(() => {
      const b = document.body;
      if (${theme === 'dark' ? 'true' : 'false'}) {
        if (!b.hasAttribute('data-ds-dark-theme')) b.setAttribute('data-ds-dark-theme', '');
      } else {
        b.removeAttribute('data-ds-dark-theme');
      }
      return true;
    })()`)
    await new Promise((r) => setTimeout(r, 700))

    const dom = await view.webContents.executeJavaScript(SAMPLE_SCRIPT)
    // 抓 overlay 覆盖区（右上角），并排除最右侧边缘的按钮画笔影响：取靠左的空白像素
    const shot = await view.webContents.capturePage({
      x: Math.max(0, dom.innerWidth - PROBE_W), y: 0, width: PROBE_W, height: OVERLAY_H
    })
    const samples = {}
    for (const [name, sx] of [['left', 6], ['mid', 60], ['right', PROBE_W - 6]]) {
      samples[name] = toHex(px(shot, sx, Math.round(OVERLAY_H / 2)))
    }
    // 再取 overlay 带正下方一行（y=OVERLAY_H+6）作为「按钮层本该匹配的底色」
    const below = await view.webContents.capturePage({
      x: Math.max(0, dom.innerWidth - PROBE_W), y: OVERLAY_H + 6, width: PROBE_W, height: 10
    })
    const belowHex = toHex(px(below, Math.round(PROBE_W / 2), 5))
    report[theme] = { dom, overlayBandPixels: samples, bandBelow: belowHex }
  }

  console.log('\n=================== 取色报告 ===================')
  for (const k of Object.keys(report)) {
    const r = report[k]
    console.log(`\n----- 主题 ${k} -----`)
    console.log('  dark 标记           :', r.dom.dark, '(attr 存在:', r.dom.domDarkAttr + ')')
    console.log('  body 背景           :', r.dom.bodyBg, r.dom.bodyBgRaw)
    console.log('  :root 背景          :', r.dom.rootBg, r.dom.rootBgRaw)
    console.log('  令牌 --dsw-alias-bg-base   :', JSON.stringify(r.dom.tokens.dswBgBase))
    console.log('  令牌 --dsw-alias-bg-layer-1:', JSON.stringify(r.dom.tokens.dswBgLayer1))
    console.log('  令牌 --dsw-alias-label-primary:', JSON.stringify(r.dom.tokens.dswLabelPrimary))
    console.log('  令牌 --color-canvas        :', JSON.stringify(r.dom.tokens.colorCanvas))
    console.log('  令牌 --color-surface       :', JSON.stringify(r.dom.tokens.colorSurface))
    console.log('  overlay 带内命中链（近右边缘）:')
    for (const c of r.dom.chain) {
      console.log(`      ${c.tag} .${c.cls}  bg=${c.colorHex || c.color}${c.image ? ' img=' + c.image : ''}`)
    }
    console.log('  overlay 带像素(left/mid/right):', JSON.stringify(r.overlayBandPixels))
    console.log('  带正下方一行像素       :', r.bandBelow)
  }
  const out = path.join(os.tmpdir(), 'probe-overlay-color.json')
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log('\nJSON=' + out)

  try { child.kill() } catch { /* noop */ }
  app.exit(0)
})
