/**
 * 校验打包产物（dist/win-unpacked/resources/app.asar）里的主进程代码确实含本次改动。
 *
 * 为什么直接扫原始归档字节而不是 asar.extractFile：
 * 本机 @electron/asar 的 extractFile 对归档内 Windows 风格路径与 POSIX 风格入参都对不上，
 * 而 asar 的文件内容是**不压缩**存储的，直接按字节搜标记更省事且同样可信（同
 * verify-packaged-drag-fix.cjs 的做法）。
 *
 * 用法：node scripts/verify-packaged-footer.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const ARCHIVE = path.resolve(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar')
if (!fs.existsSync(ARCHIVE)) {
  console.error('✗ 找不到打包产物：', ARCHIVE, '（先跑 npm run dist:dir）')
  process.exit(1)
}

const buf = fs.readFileSync(ARCHIVE)
console.log('app.asar =', (buf.length / 1048576).toFixed(1), 'MB')

const markers = [
  ['底部工具栏样式表 id', 'dsh-exo-foot-style'],
  ['壳按钮通用类名', 'dsh-exo-foot-btn'],
  ['宽/窄态标记属性', 'data-dsh-exo-rail'],
  ['管理面板入口 id', 'dsh-exo-panel-entry'],
  ['折叠切换按钮 id', 'dsh-exo-collapse-toggle'],
  ['壳按钮组类名（按键行压底的关键）', 'dsh-exo-foot-group'],
  ['管理面板桥通道', 'panel:open'],
  ['底部工具栏注入函数', 'buildSidebarFooterScript'],
  ['壳侧同步方法', 'syncSidebarFooter'],
  // 窄态规则在产物里是模板字符串（RAIL_ATTR 是插值变量），故拆成两段标记分别校验，
  // 而不是贴拼好后的字面量。
  ['窄态标记（rail 值）', 'rail"'],
  ["窄态只留设置（隐藏壳按钮）", "FOOT_GROUP_CLASS}{display:none"]
]
let bad = 0
for (const [label, m] of markers) {
  const ok = buf.includes(Buffer.from(m, 'utf8'))
  if (!ok) bad++
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + '  (' + m + ')')
}
console.log(bad === 0 ? '\n✅ 打包产物包含本次改动' : `\n✗ 缺 ${bad} 个标记`)
process.exit(bad === 0 ? 0 : 1)
