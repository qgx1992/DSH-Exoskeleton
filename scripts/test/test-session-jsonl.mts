// session-jsonl 模块测试
// 无参数：纯逻辑单测（进 npm test）；带真实 .zstd 路径：追加真实文件集成验证
import {
  extractTitle,
  extractCwd,
  decodeWorkspaceName,
  projectNameFromPath,
  truncate
} from '../../src/shared/session-jsonl.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

console.log('4) 会话日志文件名解析（Session format 代数）')
{
  const { parseSessionLogName, resolveSessionLog } = await import('../../src/shared/session-jsonl.ts')
  assert(parseSessionLogName('session.jsonl.zstd')?.version === 0, 'v0 = session.jsonl.zstd')
  assert(parseSessionLogName('session.jsonl')?.compressed === false, '明文 v0 可识别且标记未压缩')
  assert(parseSessionLogName('session.v3.jsonl.zstd')?.version === 3, 'v3 = session.v3.jsonl.zstd')
  assert(parseSessionLogName('session.v12.jsonl.zstd')?.version === 12, '多位代数 v12')
  assert(parseSessionLogName('session.v0.jsonl.zstd') === null, 'session.v0 非规范名（v0 不带 .vN）')
  assert(parseSessionLogName('session.V3.jsonl.zstd') === null, '大写 .V3 非规范名')
  assert(parseSessionLogName('session.v03.jsonl.zstd') === null, '前导零非规范名')
  assert(parseSessionLogName('other.jsonl.zstd') === null, '非会话日志名忽略')

  // 目录择优：模拟内核格式迁移后 v0 与 v3 并存（实际环境 14 个会话处于该状态）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-logresolve-'))
  const dir = path.join(tmp, 'session-x')
  fs.mkdirSync(dir)
  assert(resolveSessionLog(dir) === null, '空目录无日志 → null')
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), '')
  assert(resolveSessionLog(dir)?.version === 0, '仅 v0 → 选 v0')
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), '')
  const picked = resolveSessionLog(dir)
  assert(picked?.version === 3, 'v0+v3 并存 → 选最高代数 v3（读 v0 会拿到迁移前陈旧内容）')
  assert(picked?.name === 'session.v3.jsonl.zstd', '返回准确文件名')
  assert(picked?.file === path.join(dir, 'session.v3.jsonl.zstd'), '返回绝对路径')
  assert(picked?.compressed === true, '标记 zstd 压缩')
  fs.writeFileSync(path.join(dir, 'session.v10.jsonl.zstd'), '')
  assert(resolveSessionLog(dir)?.version === 10, '更高代数 v10 优先于 v3')
  fs.writeFileSync(path.join(dir, 'junk.txt'), '')
  assert(resolveSessionLog(dir)?.version === 10, '无关文件不影响择优')
  assert(resolveSessionLog(path.join(tmp, 'missing')) === null, '目录不存在 → null 不抛')
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('5) 通知标题拼装（项目名入标题行，v0.9.5 文案）')
{
  const { notificationTitle } = await import('../../src/shared/session-jsonl.ts')
  assert(notificationTitle('myproj', 'DSH 对话完成') === 'myproj · DSH 对话完成', '有项目名 → 标题行前缀')
  assert(notificationTitle('myproj', 'DSH 等待你的回答') === 'myproj · DSH 等待你的回答', '询问卡标题同样拼项目名')
  assert(notificationTitle('', 'DSH 对话完成') === 'DSH 对话完成', '无项目名 → 不显示空分隔符')
  assert(notificationTitle('   ', 'DSH 对话完成') === 'DSH 对话完成', '空白项目名同样跳过')
  assert(notificationTitle('中文项目', 'DSH 对话完成') === '中文项目 · DSH 对话完成', '中文项目名')
}

console.log('6) 帧扫描/真实文件（可选）')
const file = process.argv[2]
if (file && fs.existsSync(file)) {
  const { scanZstdFrames, readSessionRecords } = await import('../../src/shared/session-jsonl.ts')
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