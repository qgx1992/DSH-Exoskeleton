// 发布前安全检查：确认更新日志不含明文凭据（AGENT.md 安全红线）
const fs = require('fs')
const s = fs.readFileSync('scripts/out/release-notes-v0.9.5.md', 'utf8')
const patterns = [
  ['OpenAI 风格 key', /sk-[A-Za-z0-9_-]{16,}/],
  ['GitHub OAuth token', /gho_[A-Za-z0-9]{20,}/],
  ['GitHub PAT', /ghp_[A-Za-z0-9]{20,}/],
  ['PEM 私钥头', /-----BEGIN/],
  ['疑似 JWT', /eyJ[A-Za-z0-9_-]{20,}\./]
]
let bad = 0
for (const [label, re] of patterns) {
  if (re.test(s)) { console.log('✗', label); bad++ }
}
console.log('长度:', s.length, '字符')
console.log(bad === 0 ? '✓ 未发现明文凭据' : '✗ 发现 ' + bad + ' 类敏感内容')
process.exit(bad === 0 ? 0 : 1)
