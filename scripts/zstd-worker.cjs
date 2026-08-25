// zstd worker：由系统 Node(≥22.4，内置 zstd) 运行，主进程通过 stdio 行式 JSON 请求解压/信息
// 命令：
//   {"cmd":"init"}                                   → {"ok":true,"zstd":true}
//   {"cmd":"frameEvents","file":path,"offset":n}     → {"ok":true,"events":[{type,seq,turnEndMax}]}
//   {"cmd":"headInfo","file":path}                   → {"ok":true,"cwd":"...","title":"..."}
const zlib = require('node:zlib')
const fs = require('node:fs')

const ZSTD_MAGIC = 4247762216
const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function'

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return frames
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return frames
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function decompress(buffer, frame) {
  if (!HAS_ZSTD) return ''
  try {
    return zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
  } catch {
    return ''
  }
}

function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      events.push({ type: j.type, seq: typeof j.seq === 'number' ? j.seq : 0 })
    } catch { /* noop */ }
  }
  return events
}

function handle(req, res) {
  try {
    if (req.cmd === 'init') {
      res({ ok: true, zstd: HAS_ZSTD })
      return
    }
    if (!HAS_ZSTD) {
      res({ ok: false, error: 'node zstd unsupported' })
      return
    }
    const buf = fs.readFileSync(req.file)
    if (req.cmd === 'frameEvents') {
      const offset = req.offset || 0
      if (offset >= buf.length) {
        res({ ok: true, events: [], turnEndMax: 0 })
        return
      }
      // 从 offset 前 64 字节起扫描（容忍新块从帧中间开始），定位首个 magic 作为帧起点
      const tailStart = Math.max(0, offset - 64)
      const tail = buf.subarray(tailStart)
      let magicAt = -1
      for (let o = 0; o < tail.length - 4; o++) {
        if (tail.readUInt32LE(o) === ZSTD_MAGIC) { magicAt = o; break }
      }
      if (magicAt < 0) {
        res({ ok: true, events: [], turnEndMax: 0 })
        return
      }
      const frames = scanZstdFrames(tail.subarray(magicAt))
      let events = []
      let turnEndMax = 0
      const frameStartOfs = tailStart + magicAt
      for (const fr of frames.slice(0, 6)) {
        if (frameStartOfs + fr.end <= offset) continue // 仅处理位于 offset 之后的帧
        for (const ev of parseEvents(decompress(tail.subarray(magicAt), fr))) {
          events.push(ev)
          if (ev.type === 'turn/end' && ev.seq > turnEndMax) turnEndMax = ev.seq
        }
      }
      res({ ok: true, events, turnEndMax })
      return
    }
    if (req.cmd === 'headInfo') {
      const frames = scanZstdFrames(buf)
      const records = []
      let cwd = ''
      let title = ''
      let firstUserText = ''
      for (const fr of frames.slice(0, 16)) {
        for (const line of decompress(buf, fr).split('\n')) {
          if (!line.trim()) continue
          try {
            const j = JSON.parse(line)
            if (j.type === 'session' && typeof j.cwd === 'string' && !cwd) cwd = j.cwd
            if ((j.type === 'session/title' || j.type === 'session/title-llm-request') && !title) {
              const t = j.data && j.data.title
              if (typeof t === 'string' && t.trim()) title = t.trim().slice(0, 80)
            }
            if (!title && j.type === 'user/message' && j.data && Array.isArray(j.data.content)) {
              for (const part of j.data.content) {
                if (part && typeof part.text === 'string' && part.text.trim()) {
                  title = part.text.trim().slice(0, 80)
                  break
                }
              }
            }
            // 首条用户消息（列表显示用同一来源），始终收集
            if (!firstUserText && j.type === 'user/message' && j.data && Array.isArray(j.data.content)) {
              for (const part of j.data.content) {
                if (part && typeof part.text === 'string' && part.text.trim()) {
                  firstUserText = part.text.trim().slice(0, 80)
                  break
                }
              }
            }
          } catch { /* noop */ }
        }
        if (cwd && title && firstUserText) break
      }
      res({ ok: true, cwd, title, firstUserText })
      return
    }
    res({ ok: false, error: 'unknown cmd: ' + req.cmd })
  } catch (e) {
    res({ ok: false, error: e.message })
  }
}

const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  try {
    const req = JSON.parse(line)
    handle(req, (payload) => process.stdout.write(JSON.stringify({ ...payload, id: req.id }) + '\n'))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n')
  }
})
process.stdin.on('end', () => process.exit(0))