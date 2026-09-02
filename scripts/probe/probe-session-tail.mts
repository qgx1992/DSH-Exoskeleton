// 勘察：会话文件尾部事件类型（找明确的"结束"标记）+ 前端事件通道
import { scanZstdFrames, decompressFrame } from '../../src/shared/session-jsonl.ts'
import fs from 'node:fs'

const buf = fs.readFileSync(process.argv[2])
const frames = scanZstdFrames(buf)
console.log('帧数:', frames.length)

// 解析所有帧的事件类型（统计）+ 尾部 20 条事件的类型与代表性内容
const tail = []
let typeStats = {}
for (let i = 0; i < frames.length; i++) {
  const text = decompressFrame(buf, frames[i])
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      typeStats[j.type] = (typeStats[j.type] || 0) + 1
      if (i >= frames.length - 4) tail.push(j)
    } catch { /* noop */ }
  }
}
console.log('=== 全帧事件类型统计 ===')
console.log(JSON.stringify(typeStats, null, 0))
console.log('=== 最后 4 帧事件序列（尾部，找结束标记） ===')
for (const j of tail.slice(-24)) {
  const d = JSON.stringify(j.data || {}).slice(0, 120)
  console.log(`  ${j.type} seq=${j.seq} ${d}`)
}