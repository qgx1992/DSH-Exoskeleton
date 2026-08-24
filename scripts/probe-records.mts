// 勘察：Node zlib 逐帧解出的会话事件结构（找标题/消息字段）
import zlib from 'node:zlib'
import fs from 'node:fs'

const buf = fs.readFileSync(process.argv[2])
// 用 shared 的帧扫描（直接内联引用类逻辑：读源文件解析太绕，此处简单实现——
// 直接从 test 模块复用则复制算法；这里只为勘察，先解第一个 frame）
// 简化：手动解析第一帧（读 descriptor 单段）→ 不通用；改用我的 shared 模块
import { scanZstdFrames, decompressFrame } from '../src/shared/session-jsonl.ts'
const frames = scanZstdFrames(buf)
console.log('frames:', frames.length)
const text = decompressFrame(buf, frames[0])
console.log('首帧解压长度:', text.length)
const lines = text.split('\n').filter(Boolean)
console.log('首帧行数:', lines.length)
for (let i = 0; i < Math.min(6, lines.length); i++) {
  try {
    const j = JSON.parse(lines[i])
    console.log(`行${i} keys:`, Object.keys(j).join(', '))
    console.log('   ', JSON.stringify(j).slice(0, 260))
  } catch (e) {
    console.log(`行${i} (非JSON):`, lines[i].slice(0, 120))
  }
}