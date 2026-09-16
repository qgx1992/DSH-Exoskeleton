/**
 * 校验打包产物（dist/win-unpacked/resources/app.asar）里的主进程代码确实含本次修复。
 *
 * 为什么直接扫原始归档字节而不是 asar.extractFile：
 * 本机 @electron/asar 的 extractFile 对归档内 Windows 风格路径（`\out\main\index.js`）
 * 与 POSIX 风格入参都对不上（试过三种写法均报 not found），而 asar 的文件内容是**不压缩**
 * 存储的，直接按字节搜标记更省事且同样可信。
 *
 * 用法：node scripts/verify-packaged-drag-fix.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const ARCHIVE = path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar')
if (!fs.existsSync(ARCHIVE)) {
  console.error('✗ 找不到打包产物：', ARCHIVE, '（先跑 npm run dist:dir 或 electron-builder --win）')
  process.exit(1)
}

const buf = fs.readFileSync(ARCHIVE)
console.log('app.asar =', (buf.length / 1048576).toFixed(1), 'MB')

const markers = [
  ['顶部拖拽区 CSS（会话态 header）', 'header { -webkit-app-region: drag; }'],
  ['空态拖拽条 id', 'dsh-exo-drag-strip'],
  ['空态拖拽条同步钩子', '__dshExoDragStripSync'],
  ['壳侧重新同步方法', 'syncDragStrip'],
  ['原生按钮簇宽度常量', 'WINDOW_CONTROLS_CLUSTER_WIDTH']
]
let bad = 0
for (const [label, m] of markers) {
  const ok = buf.includes(Buffer.from(m, 'utf8'))
  if (!ok) bad++
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + '  (' + m + ')')
}
console.log(bad === 0 ? '\n✅ 打包产物包含本次修复' : `\n✗ 缺 ${bad} 个标记`)
process.exit(bad === 0 ? 0 : 1)
