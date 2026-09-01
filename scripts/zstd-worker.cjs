// zstd worker：由系统 Node(≥22.4，内置 zstd) 运行，主进程通过 stdio 行式 JSON 请求解压/信息
// 命令：
//   {"cmd":"init"}                                   → {"ok":true,"zstd":true}
//   {"cmd":"frameEvents","file":path,"offset":n}     → {"ok":true,"events":[{type,seq,turnEndMax}],
//                                                      askOpens:[{callId,turn,time,questions}],
//                                                      toolResultCallIds:[string]}
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

/** 询问卡检测（session-ask）：会产出等待用户回答的卡片工具名白名单。
 *  严格按名过滤：其他工具的“call 无 result”只是慢执行（如 pwsh），不是卡片，不可泛化。 */
const ASK_TOOL_NAMES = new Set(['ask_user_question', 'exit_plan_mode'])

/** 从 tool/call 的 arguments 提取问题文本（worker 内解析并截断，主进程只收短文本）。
 *  arguments 可达数 KB 且解析可能失败，失败/非卡片工具一律返回 undefined（壳侧回退通用文案）。 */
function parseAskQuestions(name, argsJson) {
  if (!ASK_TOOL_NAMES.has(name) || typeof argsJson !== 'string' || !argsJson) return undefined
  try {
    const args = JSON.parse(argsJson)
    if (name === 'exit_plan_mode') {
      // 计划审批卡：从 plan 参数取摘要（exit_plan_mode 无 questions 数组）
      const plan = typeof args.plan === 'string' ? args.plan.trim() : ''
      return plan ? ['计划审批：' + plan.replace(/\s+/g, ' ').slice(0, 110)] : undefined
    }
    if (!Array.isArray(args.questions) || args.questions.length === 0) return undefined
    const out = []
    for (const q of args.questions) {
      if (!q || typeof q !== 'object') continue
      const header = typeof q.header === 'string' ? q.header.trim() : ''
      const question = typeof q.question === 'string' ? q.question.trim() : ''
      const text = header && question ? header + '：' + question : (question || header)
      if (text) out.push(text.slice(0, 120))
      if (out.length >= 3) break // 通知正文最多展示 3 个问题，防超长
    }
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      // kind：turn/end 的 reason.kind（completed/aborted/error/max-tokens/blocked/interrupted…）
      const kind = j.data && j.data.reason && typeof j.data.reason.kind === 'string'
        ? j.data.reason.kind
        : undefined
      // turn：turn/end 的 data.turn（轮次编号，用于按轮去重）
      const turn = j.data && typeof j.data.turn === 'number' ? j.data.turn : undefined
      const ev = {
        type: j.type,
        seq: typeof j.seq === 'number' ? j.seq : 0,
        time: typeof j.time === 'number' ? j.time : 0,
        kind,
        turn
      }
      // session-ask：tool/call 带出卡片信息（仅白名单工具）；tool/result 带出配对键 callId
      if (j.type === 'tool/call' && j.data) {
        ev.name = j.data.name
        ev.callId = j.data.callId
        ev.questions = parseAskQuestions(j.data.name, j.data.arguments)
      } else if (j.type === 'tool/result' && j.data && j.data.message && j.data.message.source) {
        ev.callId = j.data.message.source.callId
      }
      events.push(ev)
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
    // H3: 按需 seek 读取，避免整文件 readFileSync（长会话文件可达数百 MB）
    const fh = fs.openSync(req.file, 'r')
    try {
      const size = fs.fstatSync(fh).size
      if (req.cmd === 'frameEvents') {
        const offset = req.offset || 0
        if (offset >= size) {
          res({ ok: true, events: [], turnEndMax: 0 })
          return
        }
        // 从 offset 前 64 字节起只读尾部（容忍新块从帧中间开始），定位首个 magic 作为帧起点
        const tailStart = Math.max(0, offset - 64)
        const tail = Buffer.alloc(size - tailStart)
        fs.readSync(fh, tail, 0, tail.length, tailStart)
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
        const turnEnds = []
        // session-ask：本批新打开的询问卡（tool/call，白名单工具）与配对用的 result callId 集合
        const askOpens = []
        const toolResultCallIds = new Set()
        let turnStarts = 0
        // 本批最后一个 turn 事件（按 seq 最大者判定类型）：
        //   - 'end'   → 本批以轮次结束收尾，更新完成候选
        //   - 'start' → 本批以新一轮开始收尾，会话仍活跃，清除候选
        let lastTurnType = null
        let lastTurnSeq = -1
        // 本批所有非 interrupted turn/end 的最大事件时间（ms）
        let lastEndTime = 0
        const frameStartOfs = tailStart + magicAt
        // 最多解析 64 帧：正常运行每次 flush 仅 1 帧（批窗口 200ms），
        // 但崩溃修复（repair re-encode）或观察间隔较长时一次增长可达数十帧
        for (const fr of frames.slice(0, 64)) {
          if (frameStartOfs + fr.end <= offset) continue // 仅处理位于 offset 之后的帧
          for (const ev of parseEvents(decompress(tail.subarray(magicAt), fr))) {
            events.push(ev)
            if (ev.type === 'turn/end') {
              if (ev.seq > turnEndMax) turnEndMax = ev.seq
              turnEnds.push({ seq: ev.seq, time: ev.time, kind: ev.kind, turn: ev.turn })
              if (ev.kind !== 'interrupted' && ev.time > lastEndTime) lastEndTime = ev.time
              if (ev.seq > lastTurnSeq) { lastTurnSeq = ev.seq; lastTurnType = 'end' }
            } else if (ev.type === 'turn/start') {
              turnStarts++
              if (ev.seq > lastTurnSeq) { lastTurnSeq = ev.seq; lastTurnType = 'start' }
            } else if (ev.type === 'tool/call' && ASK_TOOL_NAMES.has(ev.name) && ev.callId) {
              askOpens.push({ callId: ev.callId, turn: ev.turn, time: ev.time, questions: ev.questions })
            } else if (ev.type === 'tool/result' && ev.callId) {
              toolResultCallIds.add(ev.callId)
            }
          }
        }
        res({ ok: true, events, turnEndMax, turnEnds, turnStarts, lastTurnType, lastEndTime,
          askOpens, toolResultCallIds: [...toolResultCallIds] })
        return
      }
      if (req.cmd === 'headInfo') {
        // 只读头部（最多 512KB，足够前 16 帧取标题/cwd），避免整文件读入
        const headLen = Math.min(size, 512 * 1024)
        const buf = Buffer.alloc(headLen)
        fs.readSync(fh, buf, 0, headLen, 0)
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
    } finally {
      fs.closeSync(fh)
    }
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