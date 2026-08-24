/**
 * 从官方 favicon.svg 提取鲸鱼路径，生成黑金配色 SVG：
 * 1) resources/official/whale-gold.svg      — 透明底金色鲸鱼（托盘/图标素材）
 * 2) resources/official/app-icon-blackgold.svg — 黑底圆角 + 金色鲸鱼（应用图标）
 * 运行：node scripts/build-blackgold.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const officialDir = path.join(__dirname, '..', 'resources', 'official')

const favicon = fs.readFileSync(path.join(officialDir, 'favicon.svg'), 'utf-8')
const dMatch = favicon.match(/<path[^>]*\sd="([^"]+)"/)
if (!dMatch) {
  console.error('未在 favicon.svg 中找到 path d')
  process.exit(1)
}
const whaleD = dMatch[1]

// 金色渐变（黑金质感：亮金高光 → 主金 → 深金）
const gradient = `
  <linearGradient id="gold" x1="0" y1="0" x2="0.2" y2="1">
    <stop offset="0%" stop-color="#F7E08B"/>
    <stop offset="52%" stop-color="#D4AF37"/>
    <stop offset="100%" stop-color="#8C6114"/>
  </linearGradient>`

// 1) 透明底金色鲸鱼
const whaleGold = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 50 50">
  <defs>${gradient}</defs>
  <path d="${whaleD}" fill="url(#gold)" fill-rule="nonzero"/>
</svg>`
fs.writeFileSync(path.join(officialDir, 'whale-gold.svg'), whaleGold)

// 2) 黑底圆角 + 金色鲸鱼（应用图标，鲸鱼居中留白）
const blackBg = `#0B0B0D` // 近纯黑
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>${gradient}
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#17181C"/>
      <stop offset="100%" stop-color="#050506"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#bg)"/>
  <g transform="translate(15.5 15.5) scale(4.5)">
    <path d="${whaleD}" fill="url(#gold)" fill-rule="nonzero"/>
  </g>
</svg>`
fs.writeFileSync(path.join(officialDir, 'app-icon-blackgold.svg'), appIcon)

console.log('生成完成:')
console.log('  whale-gold.svg          (透明底金色鲸鱼)')
console.log('  app-icon-blackgold.svg  (黑金应用图标)')