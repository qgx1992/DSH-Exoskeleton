/**
 * 打包产物校验：确认 beta 包内真的是本次改动（含自动更新双开关）。
 * 依据 AGENT.md §7 第 4 条教训——「源码改了但产物是旧的」会造成假通过，
 * 故构建后必须开箱核对（读 asar 内的 main/渲染层代码，不看工作区）。
 *
 * asar 路径坑（本次实测踩到）：`listPackage()` 返回的条目带**前导反斜杠**
 * （形如 `\out\renderer\assets\index-xxx.js`），而 `extractFile()` 只认
 * 「去掉前导斜杠、保留反斜杠」这一种形式。若把它转成正斜杠再提取会抛异常；
 * 而先前版本用 `try { … } catch { continue }` 把异常吞了 → 渲染层六项检查
 * 全部误报 false，差点得出「产物没更新、要重新构建」的错误结论。
 * 故此处对提取失败**显式报错退出**：路径写错必须响，不能伪装成内容缺失。
 */
const asar = require('@electron/asar')
const fs = require('fs')
const path = require('path')

const p = path.join('dist', 'win-unpacked', 'resources', 'app.asar')
if (!fs.existsSync(p)) {
  console.error('✗ 未找到 app.asar：', p)
  process.exit(1)
}

/** asar 条目 → extractFile 可用路径（去前导斜杠，保留反斜杠） */
const asarPath = (entry) => entry.replace(/^[\\/]/, '')

/** 提取失败必须显式报错：静默 catch 会把「路径写错」伪装成「产物缺内容」 */
function extractOrDie(entry) {
  try {
    return asar.extractFile(p, asarPath(entry)).toString('utf8')
  } catch (e) {
    console.error('✗ 无法提取 asar 条目：', JSON.stringify(entry), '→', e.message)
    process.exit(1)
  }
}

const pkg = JSON.parse(extractOrDie('package.json'))
console.log('asar 内 package.json version =', pkg.version)

const main = extractOrDie(path.join('out', 'main', 'index.js'))

const checks = {
  '主进程含 autoCheckUpdate 配置字段': main.includes('autoCheckUpdate'),
  '主进程含 autoDownloadUpdate 配置字段': main.includes('autoDownloadUpdate'),
  '主进程含 applyAutoSwitches（运行期同步开关）': main.includes('applyAutoSwitches'),
  '主进程含 checkIfAutoEnabled（启动后台检查受开关约束）': main.includes('checkIfAutoEnabled'),
  '主进程含 updater:download IPC 通道': main.includes('updater:download'),
  '主进程含 autoUpdateSupported（UI 按能力显隐按钮）': main.includes('autoUpdateSupported'),
  '主进程含 downloadUpdate（手动下载路径）': main.includes('downloadUpdate'),
  '不应再含旧方法名 applyAutoCheckSwitch（已改名为 applyAutoSwitches）': !main.includes('applyAutoCheckSwitch')
}

let ok = true
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false
  console.log(v ? '✓' : '✗', k)
}

// 渲染层：两个开关的文案与控件必须都在
console.log('\n渲染层资源在 asar 内 out/renderer/assets/，逐块扫描关键字')
const rendererFiles = asar.listPackage(p).filter((f) => f.indexOf('renderer') >= 0 && f.endsWith('.js'))
if (rendererFiles.length === 0) {
  console.error('✗ 未在 asar 内找到渲染层 js（校验无法进行）')
  process.exit(1)
}

let rOk = true
const rChecks = {
  '渲染层含「自动检查更新」文案': false,
  '渲染层含「自动下载更新」文案': false,
  '渲染层含「下载更新」按钮文案': false,
  '渲染层提交 autoCheckUpdate': false,
  '渲染层提交 autoDownloadUpdate': false,
  '渲染层调用 updater.download': false
}
for (const f of rendererFiles) {
  const s = extractOrDie(f)
  if (s.includes('自动检查更新')) rChecks['渲染层含「自动检查更新」文案'] = true
  if (s.includes('自动下载更新')) rChecks['渲染层含「自动下载更新」文案'] = true
  if (s.includes('下载更新')) rChecks['渲染层含「下载更新」按钮文案'] = true
  if (s.includes('autoCheckUpdate')) rChecks['渲染层提交 autoCheckUpdate'] = true
  if (s.includes('autoDownloadUpdate')) rChecks['渲染层提交 autoDownloadUpdate'] = true
  if (s.includes('updater.download')) rChecks['渲染层调用 updater.download'] = true
}
for (const [k, v] of Object.entries(rChecks)) {
  if (!v) rOk = false
  console.log(v ? '✓' : '✗', k)
}

if (ok && rOk) {
  console.log('\n结论：产物与本次改动一致（含自动更新双开关）')
  process.exit(0)
}
console.error('\n结论：产物与源码不一致，请重新构建')
process.exit(1)
