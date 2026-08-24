// 勘察：解压一个 DSH 会话 jsonl，查看结构与元数据字段
import { ZSTDDecoder } from 'zstddec'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const file = process.argv[2]
const buf = fs.readFileSync(file)
const decoder = new ZSTDDecoder()
await decoder.init()
const decompressed = decoder.decode(buf)
const text = decompressed.toString('utf-8')
const lines = text.split('\n').filter((l) => l.trim())
console.log('解压后:', (decompressed.length / 1024).toFixed(1), 'KB, 行数:', lines.length)
console.log('--- 前 3 行 ---')
for (const l of lines.slice(0, 3)) {
  try {
    console.log(JSON.stringify(JSON.parse(l)).slice(0, 420))
  } catch {
    console.log('(非JSON) ' + l.slice(0, 420))
  }
}
console.log('--- 最后 1 行 ---')
for (const l of lines.slice(-1)) {
  try {
    console.log(JSON.stringify(JSON.parse(l)).slice(0, 420))
  } catch {
    console.log(l.slice(0, 420))
  }
}
const keys = new Set()
for (const l of lines.slice(0, 60)) {
  try {
    Object.keys(JSON.parse(l)).forEach((k) => keys.add(k))
  } catch { /* noop */ }
}
console.log('--- 字段 ---', [...keys].join(', '))