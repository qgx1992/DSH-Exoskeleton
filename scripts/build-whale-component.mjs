/**
 * 从官方 favicon.svg 提取鲸鱼路径，生成 WhaleIcon React 组件（黑金配色）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const favicon = fs.readFileSync(path.join(__dirname, '..', 'resources', 'official', 'favicon.svg'), 'utf-8')
const m = favicon.match(/<path[^>]*\sd="([^"]+)"/)
if (!m) {
  console.error('未找到鲸鱼 path')
  process.exit(1)
}
const d = m[1]

const tsx = `/**
 * 官方 DeepSeek 鲸鱼图标（黑金配色）
 * 矢量来源: fe-static.deepseek.com/chat/favicon.svg（官方路径，仅改配色）
 */
interface Props {
  size?: number
  className?: string
  gradientId?: string
}

export function WhaleIcon({ size = 16, className, gradientId = 'whale-gold' }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 50 50" fill="none" className={className}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0.2" y2="1">
          <stop offset="0%" stopColor="#F7E08B" />
          <stop offset="52%" stopColor="#D4AF37" />
          <stop offset="100%" stopColor="#8C6114" />
        </linearGradient>
      </defs>
      <path d="${d}" fill="url(#${'${gradientId}'})" fillRule="nonzero" />
    </svg>
  )
}
`
fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'components', 'WhaleIcon.tsx'), tsx)
console.log('WhaleIcon.tsx 生成完成, len =', tsx.length)