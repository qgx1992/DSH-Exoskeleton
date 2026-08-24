/**
 * 用 Electron BrowserWindow + canvas 将黑金 SVG 渲染为高清 PNG：
 *   resources/icon.png  (256x256 黑金应用图标)
 *   resources/tray.png  (32x32 托盘图标，金色鲸鱼)
 * 运行：electron scripts/render-icons.cjs
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const officialDir = path.join(__dirname, '..', 'resources', 'official')
const resourcesDir = path.join(__dirname, '..', 'resources')

function svgToDataUrl(file) {
  const svg = fs.readFileSync(file, 'utf-8')
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}

const PAGE = `<!doctype html><html><body style="margin:0">
<canvas id="c"></canvas>
<script>
async function render(svgUrl, w, h) {
  const img = new Image();
  img.src = svgUrl;
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img load failed')); });
  const c = document.getElementById('c');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/png');
}
</script></body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))

    const png256 = await win.webContents.executeJavaScript(
      `render(${JSON.stringify(svgToDataUrl(path.join(officialDir, 'app-icon-blackgold.svg')))}, 256, 256)`
    )
    fs.writeFileSync(path.join(resourcesDir, 'icon.png'), Buffer.from(png256.split(',')[1], 'base64'))
    console.log('icon.png 256x256 黑金应用图标 OK')

    const png32 = await win.webContents.executeJavaScript(
      `render(${JSON.stringify(svgToDataUrl(path.join(officialDir, 'whale-gold.svg')))}, 32, 32)`
    )
    fs.writeFileSync(path.join(resourcesDir, 'tray.png'), Buffer.from(png32.split(',')[1], 'base64'))
    console.log('tray.png 32x32 金色鲸鱼 OK')

    console.log('DONE')
    app.exit(0)
  } catch (e) {
    console.error('渲染失败:', e && (e.message || e))
    app.exit(1)
  }
})