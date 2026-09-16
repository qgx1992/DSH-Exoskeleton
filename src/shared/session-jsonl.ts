/**
 * @shared DSH 会话 jsonl(.zstd) 读取与工作区解码
 * - 容器格式：多帧 zstd（每追加批次一个独立 frame，带校验和），与 dsh-session-persistence-jsonl 一致
 * - 解压：Node 内置 zlib.zstdDecompressSync（Node ≥22.4 / 24 自带）
 * - 性能：仅解压头部若干帧即可取得会话标题/首条消息（长会话避免全量解压）
 * - 文件名：会话日志按 Session format 代数命名，**不是固定的 session.jsonl**（见下方 resolveSessionLog）
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export interface SessionRecord {
  /** 事件原始行（JSON.parse 失败时为 null） */
  parsed: Record<string, unknown> | null
  line: string
}

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528

/** 结构化扫描 zstd frame 边界（与 dsh-cost-meter/backfill.js 同算法） */
export function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return frames // 保留位：结构非法
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

/** 解压指定帧区间为文本（无 zstd 支持时返回空串） */
export function decompressFrame(buffer: Buffer, frame: { start: number; end: number }): string {
  try {
    if (typeof zlib.zstdDecompressSync !== 'function') return ''
    const out = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end))
    return out.toString('utf8')
  } catch {
    return ''
  }
}

/** 解压前 maxFrames 帧，逐行解析为记录（跨帧行缓冲） */
export function readSessionRecords(buffer: Buffer, maxFrames = 8, maxBytes = 512 * 1024): SessionRecord[] {
  const records: SessionRecord[] = []
  const frames = scanZstdFrames(buffer)
  let offset = 0
  for (const f of frames.slice(0, maxFrames)) {
    if (offset >= f.end) continue
    const text = decompressFrame(buffer, f)
    offset = f.end
    if (!text) continue
    // 逐行解析（每帧内部通常以 \n 结尾）
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push({ parsed: JSON.parse(line) as Record<string, unknown>, line })
      } catch {
        records.push({ parsed: null, line })
      }
      if (records.length >= 300) return records
      if (text.length > maxBytes) return records
    }
  }
  return records
}

/** 从会话记录中提取标题：优先 session/title 事件，其次首条用户消息，最后 fallback */
export function extractTitle(records: SessionRecord[], fallbackUuid: string): string {
  // 1) DSH 自动生成的标题事件
  for (const r of records) {
    const p = r.parsed
    if (!p) continue
    if (p.type === 'session/title' || p.type === 'session/title-llm-request') {
      const t = (p.data as { title?: string } | undefined)?.title
      if (typeof t === 'string' && t.trim()) return truncate(t.trim(), 80)
    }
  }
  // 2) 首条用户消息内容
  for (const r of records) {
    const p = r.parsed
    if (!p) continue
    if (p.type === 'user/message') {
      const content = firstTextContent((p.data as Record<string, unknown> | undefined) ?? {})
      if (content) return truncate(content, 80)
    }
  }
  return `会话 ${fallbackUuid.slice(0, 8)}`
}

/** 从会话记录中取 cwd（项目真实路径），无则空 */
export function extractCwd(records: SessionRecord[]): string {
  for (const r of records) {
    const p = r.parsed
    if (p?.type === 'session' && typeof p.cwd === 'string') return p.cwd
  }
  return ''
}

function firstTextContent(p: Record<string, unknown>): string {
  const c = p.content
  if (typeof c === 'string' && c.trim()) return c.trim()
  if (Array.isArray(c)) {
    for (const part of c) {
      if (typeof part === 'string' && part.trim()) return part.trim()
      if (part && typeof part === 'object') {
        const pt = part as Record<string, unknown>
        if (typeof pt.text === 'string' && pt.text.trim()) return pt.text.trim()
        if (typeof pt.content === 'string' && pt.content.trim()) return pt.content.trim()
      }
    }
  }
  return ''
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * 会话日志文件名（Session format 代数寻址，镜像内核 dsh-session-format 的规则）：
 *   generation 0 → `session.jsonl`；generation N ≥ 1 → `session.vN.jsonl`
 * 每个世代再叠压缩后缀（本应用场景为 `.zstd`，见 dsh-session-persistence-jsonl 的 logSuffix）。
 *
 * 背景（线上故障根因）：内核 0.1.5 起 Session format 升到 v3，写盘文件名从
 * `session.jsonl.zstd` 变为 `session.v3.jsonl.zstd`。壳侧一律硬编码旧名，导致
 * stat 恒失败 → 会话完成通知彻底失效、面板会话列表只看得见未升级的旧会话。
 * 因此凡是要定位会话日志的地方，都必须走 resolveSessionLog 而不是拼字面量。
 */
export const SESSION_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/

/** 会话日志引用（解析结果） */
export interface SessionLogRef {
  /** 文件名（含压缩后缀），如 `session.v3.jsonl.zstd` */
  name: string
  /** Session format 代数（v0 = `session.jsonl`；缺失 `.vN` 即 0） */
  version: number
  /** 绝对路径 */
  file: string
  /** 是否 zstd 压缩（false = 明文 .jsonl，本应用的 worker 无法解压，调用方应告警） */
  compressed: boolean
}

/** 解析规范会话日志文件名；非规范名（`session.v0.jsonl`/含压缩前缀/大小写不符）返回 null */
export function parseSessionLogName(name: string): { version: number; compressed: boolean } | null {
  const m = SESSION_LOG_RE.exec(name)
  if (!m) return null
  return { version: m[1] === undefined ? 0 : Number(m[1]), compressed: m[2] !== undefined }
}

/**
 * 定位会话目录下应当被读取的日志文件：按内核口径取**最高代数**。
 * 内核每次格式迁移都新写一个 `session.vN.jsonl`（旧文件保留不删），所以
 * v0 与 v3 可能并存 —— 此时必须读 v3，读 v0 会拿到迁移前的陈旧内容。
 * @returns 无规范命名的日志时返回 null
 */
export function resolveSessionLog(sessionDir: string): SessionLogRef | null {
  let names: string[]
  try {
    names = fs.readdirSync(sessionDir)
  } catch {
    return null
  }
  let best: { name: string; version: number; compressed: boolean } | null = null
  for (const name of names) {
    const parsed = parseSessionLogName(name)
    if (!parsed) continue
    // 先比代数；同代数（理论上不会出现）偏向可解压的 .zstd
    if (
      !best ||
      parsed.version > best.version ||
      (parsed.version === best.version && parsed.compressed && !best.compressed)
    ) {
      best = { name, version: parsed.version, compressed: parsed.compressed }
    }
  }
  if (!best) return null
  return { ...best, file: path.join(sessionDir, best.name) }
}

/**
 * 解码 DSH 工作区目录名中的 ~XXXX 编码（Unicode → 字符）。
 * 注意：目录名对路径分隔符/盘符做了有损编码，仅作显示后备；
 * 可靠的项目路径以会话记录中的 cwd 字段为准（见 extractCwd）。
 */
export function decodeWorkspaceName(name: string): string {
  const trimmed = name.replace(/^--|--$/g, '')
  return trimmed.replace(/~([0-9A-Fa-f]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** 从路径取项目显示名（最后一级目录；路径分隔符兼容） */
export function projectNameFromPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : p
}