/**
 * 独立测试 @shared/credentials 的解析/编辑逻辑（Node 24 原生运行 TS，无需 electron）
 * 运行：node --experimental-strip-types scripts/test/test-credentials.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseRefs,
  isValidApiKey,
  editCredentialsText,
  removeCredentialsText,
  readCredentialsFile
} from '../../src/shared/credentials.ts'

let passed = 0
let failed = 0
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}`)
  }
}

const tmp = path.join(os.tmpdir(), 'dsh-cred-test-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })
const file = path.join(tmp, '.credentials.yaml')

console.log('1) parseRefs 解析')
const parsed = parseRefs('version: 1\nrefs:\n  TAVILY_API_KEY: tvly-xxx\n  DEEPSEEK_API_KEY: sk-abc123\n')
assert(parsed.refs['TAVILY_API_KEY'] === 'tvly-xxx', '解析 TAVILY_API_KEY')
assert(parsed.refs['DEEPSEEK_API_KEY'] === 'sk-abc123', '解析 DEEPSEEK_API_KEY')
assert(!parsed.malformed, '无 malformed')

console.log('2) isValidApiKey')
assert(isValidApiKey('sk-abc123def456'), 'sk- 前缀合法')
assert(!isValidApiKey(''), '空拒绝')
assert(!isValidApiKey('short'), '过短拒绝')
assert(isValidApiKey('x'.repeat(16)), '长字符串（无前缀）允许')

console.log('3) 不存在文件 → null')
assert(readCredentialsFile(file) === null, '文件不存在返回 null')

console.log('4) 新建文件保存')
let text = readCredentialsFile(file)
text = editCredentialsText(text ?? 'version: 1', 'DEEPSEEK_API_KEY', 'sk-primary-123')
fs.writeFileSync(file, text)
const s1 = parseRefs(fs.readFileSync(file, 'utf-8'))
assert(s1.refs['DEEPSEEK_API_KEY'] === 'sk-primary-123', '写入后存在')
assert(fs.readFileSync(file, 'utf-8').includes('version: 1'), '保留 version 头')

console.log('5) 覆盖保存不重复')
text = editCredentialsText(fs.readFileSync(file, 'utf-8'), 'DEEPSEEK_API_KEY', 'sk-primary-456')
fs.writeFileSync(file, text)
const c5 = (fs.readFileSync(file, 'utf-8').match(/DEEPSEEK_API_KEY/g) || []).length
assert(c5 === 1, `DEEPSEEK_API_KEY 出现 ${c5} 次（应为 1）`)
assert(fs.readFileSync(file, 'utf-8').includes('sk-primary-456'), '值已更新')

console.log('6) 保留其他 refs 并插入')
fs.writeFileSync(file, 'version: 1\nrefs:\n  TAVILY_API_KEY: tvly-keep\n', 'utf-8')
text = editCredentialsText(fs.readFileSync(file, 'utf-8'), 'OPENDEEPSEEK_KEY', 'sk-new-xyz')
fs.writeFileSync(file, text)
const s6 = parseRefs(fs.readFileSync(file, 'utf-8'))
assert(s6.refs['TAVILY_API_KEY'] === 'tvly-keep', 'TAVILY 保留')
assert(s6.refs['OPENDEEPSEEK_KEY'] === 'sk-new-xyz', '新 key 插入')

console.log('7) 无 refs 块时追加')
fs.writeFileSync(file, 'random: top-level\n')
text = editCredentialsText(fs.readFileSync(file, 'utf-8'), 'DEEPSEEK_API_KEY', 'sk-tail-1')
const s7 = parseRefs(text)
assert(s7.refs['DEEPSEEK_API_KEY'] === 'sk-tail-1', '追加成功')
assert(text.includes('random: top-level'), '顶层内容保留')

console.log('8.5) removeCredentialsText 清除')
const before = 'version: 1\nrefs:\n  TAVILY_API_KEY: tvly-keep\n  DEEPSEEK_API_KEY: sk-remove-me\n'
const after = removeCredentialsText(before, 'DEEPSEEK_API_KEY')
const s85 = parseRefs(after)
assert(s85.refs['DEEPSEEK_API_KEY'] === undefined, '目标 key 已移除')
assert(s85.refs['TAVILY_API_KEY'] === 'tvly-keep', '其他 refs 保留')
const only = removeCredentialsText('version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-only\n', 'DEEPSEEK_API_KEY')
assert(!only.includes('refs:'), 'refs 块为空时一并清理')
assert(only.trim() === 'version: 1', '顶层保留: ' + JSON.stringify(only.trim()))

console.log('8) malformed 检测')
const mal = parseRefs('version: 1\nrefs:\n  奇怪内容在这里\n')
assert(mal.malformed, '非法行触发 malformed')
assert(parseRefs('version: 1\nrefs:\n  # 注释\n  A: b\n').malformed === false, '注释行不触发 malformed')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)