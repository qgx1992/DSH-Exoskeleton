// session-jsonl 模块测试
// 无参数：纯逻辑单测（进 npm test）；带真实 .zstd 路径：追加真实文件集成验证
import {
  extractTitle,
  extractCwd,
  decodeWorkspaceName,
  projectNameFromPath,
  truncate
} from '../src/shared/session-jsonl.ts'
import fs from 'node:fs'

let passed = 0
let failed = 0
const assert = (cond, label) => {
  if (cond) { passed++; console.log('  ✓', label) } else { failed++; console.error('  ✗', label) }
}

console.log('1) 标题提取（合成记录）')
assert(
  extractTitle([{ parsed: { type: 'session/title', data: { title: ' 整理文档 ' } }, line: '' }], 'ab12') === '整理文档',
  'session/title 优先且 trim'
)
assert(
  extractTitle(
    [{ parsed: { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '帮我写一个方案' }] } }, line: '' }],
    'ab12'
  ) === '帮我写一个方案',
  '用户消息回退'
)
const longTitle = extractTitle([{ parsed: { type: 'session/title', data: { title: 'x'.repeat(120) } }, line: '' }], 'ab12')
assert(longTitle.length === 81 && longTitle.endsWith('…'), '超长标题截断')
assert(extractTitle([], 'ab12') === '会话 ab12', '空记录 fallback')

console.log('2) cwd 提取')
assert(extractCwd([{ parsed: { type: 'session', cwd: 'D:\\proj' }, line: '' }]) === 'D:\\proj', '取 session 头 cwd')
assert(extractCwd([{ parsed: { type: 'other' }, line: '' }]) === '', '无 cwd 返回空')
assert(projectNameFromPath('D:\\A my project\\研究agent桌面端\\DSH-Exoskeleton') === 'DSH-Exoskeleton', '项目名取末级')

console.log('3) 工作区名解码')
assert(decodeWorkspaceName('--D-A-my~0020project-~7814~7A76agent--').includes('研究'), '~XXXX 中文解码')
assert(decodeWorkspaceName('--C-Users-QIU-~0020.dsh--').includes(' '), '~0020 空格解码')
assert(truncate('abcde', 3) === 'abc…', 'truncate')

console.log('4) 帧扫描/真实文件（可选）')
const file = process.argv[2]
if (file && fs.existsSync(file)) {
  const { scanZstdFrames, readSessionRecords } = await import('../src/shared/session-jsonl.ts')
  const buf = fs.readFileSync(file)
  const frames = scanZstdFrames(buf)
  assert(frames.length > 0, `真实会话识别 ${frames.length} 个 frame`)
  const records = readSessionRecords(buf, 16)
  const title = extractTitle(records, 'ab12')
  const cwd = extractCwd(records)
  console.log('   真实标题:', JSON.stringify(title), '| cwd:', cwd)
  assert(title.length > 0 && title !== '会话 ab12', '真实标题提取')
  assert(cwd.length > 0, '真实 cwd 提取')
} else {
  console.log('   （未提供真实文件，跳过集成断言；开发时可用真实 .zstd 手动验证）')
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)