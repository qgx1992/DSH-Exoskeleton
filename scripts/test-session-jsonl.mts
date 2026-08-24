// 验证：session-jsonl 模块（真实 DSH 会话文件：帧扫描/标题/cwd/工作区解码）
import {
  scanZstdFrames,
  readSessionRecords,
  extractTitle,
  extractCwd,
  decodeWorkspaceName,
  projectNameFromPath
} from '../src/shared/session-jsonl.ts'
import fs from 'node:fs'

let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}

const file = process.argv[2]
if (!file) {
  console.error('用法: node --experimental-strip-types scripts/test-session-jsonl.mts <session.jsonl.zstd>')
  process.exit(1)
}
const buf = fs.readFileSync(file)

console.log('1) 帧扫描')
const frames = scanZstdFrames(buf)
assert(frames.length > 0, `识别 ${frames.length} 个 zstd frame`)
assert(frames[0].start === 0, '首帧从 0 开始')
assert(frames[frames.length - 1].end <= buf.length, '末帧边界合法')

console.log('2) 记录解析')
const records = readSessionRecords(buf, 16)
assert(records.length > 0, `解析出 ${records.length} 条事件`)
assert(records.some((r) => r.parsed?.type === 'session'), '含 session 头事件')

console.log('3) 标题提取')
const title = extractTitle(records, 'ab12cd34')
console.log('   标题:', JSON.stringify(title))
assert(title.length > 0 && title !== '会话 ab12cd34', '提取到真实标题（session/title 或用户消息）')

console.log('4) 项目路径（cwd）')
const cwd = extractCwd(records)
console.log('   cwd:', cwd)
assert(cwd.length > 0, '提取到会话 cwd')
assert(projectNameFromPath(cwd).length > 0, `项目名: ${projectNameFromPath(cwd)}`)

console.log('5) 工作区名 ~XXXX 解码')
const decoded = decodeWorkspaceName('--D-A-my~0020project-~7814~7A76agent--')
assert(decoded.includes('研究') && decoded.includes('agent'), '中文 ~7814~7A76 解码为"研究"')
assert(decoded.includes(' '), '空格 ~0020 解码成功')

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)