/**
 * @shared DSH credentials.yaml 的纯文件编辑逻辑（无 electron 依赖，可独立测试）
 * 结构：
 *   version: 1
 *   refs:
 *     ENV_NAME: value
 */
import fs from 'node:fs'
import path from 'node:path'

export interface CredentialsParse {
  refs: Record<string, string>
  malformed: boolean
}

/** 轻量解析顶层 refs 块下的 `  KEY: value` 行 */
export function parseRefs(text: string): CredentialsParse {
  const refs: Record<string, string> = {}
  let malformed = false
  let inRefs = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^refs:\s*$/i.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (line.length > 0 && /^\S/.test(line) && !/^\s/.test(line)) {
      inRefs = false // 退出 refs 块
      continue
    }
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(.*)$/)
    if (m) {
      refs[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
    } else if (/\S/.test(line) && !/^\s*#/.test(line)) {
      malformed = true
    }
  }
  return { refs, malformed }
}

export function isValidApiKey(key: string): boolean {
  const t = key.trim()
  if (!t) return false
  if (/^sk-[\w-]+$/i.test(t)) return true
  return t.length >= 16
}

/** 在 credentials 文件文本中写入/更新指定 env 的 key，保留其余内容 */
export function editCredentialsText(
  text: string,
  env: string,
  value: string
): string {
  const lines = text.trim().length === 0 ? ['version: 1', 'refs:'] : text.split(/\r?\n/)
  const refsIdx = lines.findIndex((l) => /^refs:\s*$/i.test(l.trimEnd()))
  if (refsIdx === -1) {
    // 无 refs 块：追加
    const out = [...lines]
    if (out[out.length - 1]?.trim()) out.push('')
    out.push('refs:')
    out.push(`  ${env}: ${value}`)
    return out.join('\n') + '\n'
  }
  // 遍历替换已有行
  let replaced = false
  const out: string[] = []
  let inRefs = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === refsIdx) {
      out.push(line)
      inRefs = true
      continue
    }
    if (inRefs) {
      if (line.length > 0 && /^\S/.test(line) && !/^\s/.test(line)) {
        inRefs = false
        out.push(line)
        continue
      }
      const m = line.match(new RegExp(`^(\\s{2})${escapeRegExp(env)}:\\s*(.*)$`))
      if (m) {
        out.push(`  ${env}: ${value}`)
        replaced = true
        continue
      }
      out.push(line)
      continue
    }
    out.push(line)
  }
  if (!replaced) {
    let insertAt = refsIdx + 1
    while (insertAt < out.length && /^\s{2}/.test(out[insertAt])) insertAt++
    out.splice(insertAt, 0, `  ${env}: ${value}`)
  }
  return out.join('\n') + '\n'
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 读取凭据文件（不存在返回 null） */
export function readCredentialsFile(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null
    const text = fs.readFileSync(file, 'utf-8')
    if (text.trim().length === 0) return null
    return text
  } catch {
    return null
  }
}

export function defaultCredentialsPath(dshHome: string, envOverride?: string): string {
  if (envOverride) return envOverride
  return path.join(dshHome, '.credentials.yaml')
}