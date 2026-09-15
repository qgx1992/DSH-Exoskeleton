/**
 * 真机取证：titleBarOverlay 下原生窗口按钮是否真的画出来了。
 * capturePage 只抓 web 内容、不含原生按钮与边框，故用桌面级截屏（PowerShell）抓窗口矩形。
 * 输出：窗口区域 PNG，供人眼确认「右上角是否有最小化/最大化/关闭」。
 */
const { app, BrowserWindow, Menu, WebContentsView } = require('electron')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); app.exit(1) })

const OUT = path.join(os.tmpdir(), 'overlay-native-buttons.png')

/** 用 PowerShell 抓屏幕指定矩形（GDI 截屏，物理像素） */
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)

  const win = new BrowserWindow({
    show: true, width: 900, height: 300, x: 200, y: 200,
    backgroundColor: '#0b0f17',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0f17', symbolColor: '#e6e6e6', height: 36 }
  })
  const view = new WebContentsView({})
  win.contentView.addChildView(view)
  const [cw, ch] = win.getContentSize()
  view.setBounds({ x: 0, y: 0, width: cw, height: ch })
  await view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0;background:#0b0f17;color:#8fa;font:14px sans-serif">' +
    '<div style="padding:12px">内容从 y=0 开始（此窗口应无 File/Edit/View，右上角应有 3 个窗口按钮）</div></body>'
  )).catch(() => {})
  win.focus()
  await new Promise((r) => setTimeout(r, 2000))

  const b = win.getBounds()
  const scale = require('electron').screen.getPrimaryDisplay().scaleFactor
  console.log('窗口 bounds =', JSON.stringify(b), '| 缩放 =', scale)
  try {
    grabScreen(b.x, b.y, b.width, Math.min(80, b.height), OUT)
    console.log('SHOT=' + OUT)
  } catch (err) {
    console.error('截屏失败:', err && err.message)
  }
  app.exit(0)
})
