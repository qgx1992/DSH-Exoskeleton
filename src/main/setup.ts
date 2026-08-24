/**
 * 首次启动引导（文档 §4.2.1）
 * - 检测 ~/.dsh/.credentials.yaml 是否已包含有效的 DeepSeek API Key
 * - 未配置时由渲染层弹出向导，Key 写入本地 credentials.yaml（不联网上传）
 * - 支持通过 DSH_CREDENTIALS_FILE 环境变量覆盖凭据文件路径
 * 文件编辑逻辑见 @shared/credentials（纯函数，可独立测试）
 */
import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger'
import { dshManager } from './dsh-manager'
import {
  parseRefs,
  isValidApiKey,
  editCredentialsText,
  readCredentialsFile
} from '../shared/credentials'

export const CREDENTIALS_ENV = 'DEEPSEEK_API_KEY'

export interface SetupStatus {
  /** 是否已配置（credentials.yaml 中存在非空 DEEPSEEK_API_KEY） */
  configured: boolean
  /** 凭据文件路径 */
  file: string
  /** 检测到的其他环境变量 refs（供展示） */
  refs: string[]
  /** 文件解析异常时为 true */
  malformed: boolean
}

function credentialsFile(): string {
  if (process.env.DSH_CREDENTIALS_FILE) return process.env.DSH_CREDENTIALS_FILE
  return path.join(dshManager.resolveDshHome(), '.credentials.yaml')
}

export function checkSetupStatus(): SetupStatus {
  const file = credentialsFile()
  const result: SetupStatus = { configured: false, file, refs: [], malformed: false }
  try {
    const text = readCredentialsFile(file)
    if (text === null) {
      logger.info('credentials file not found', { file })
      return result
    }
    const { refs, malformed } = parseRefs(text)
    result.refs = Object.keys(refs)
    result.malformed = malformed
    const key = refs[CREDENTIALS_ENV]
    result.configured = typeof key === 'string' && key.trim().length > 0
    logger.info('setup status checked', { file, configured: result.configured, refCount: result.refs.length })
  } catch (err) {
    logger.error('setup status check failed', err)
    result.malformed = true
  }
  return result
}

/** 保存/更新 DEEPSEEK_API_KEY 到 credentials.yaml（保留文件其余内容） */
export function saveApiKey(key: string): { ok: boolean; error?: string } {
  const trimmed = (key ?? '').trim()
  if (!isValidApiKey(trimmed)) {
    return { ok: false, error: 'API Key 为空或格式不正确（通常以 sk- 开头）' }
  }
  const file = credentialsFile()
  try {
    const existing = readCredentialsFile(file)
    const text = existing ?? 'version: 1'
    const next = editCredentialsText(text, CREDENTIALS_ENV, trimmed)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, next, 'utf-8')
    logger.info('api key saved to credentials file', { file })
    return { ok: true }
  } catch (err) {
    logger.error('save api key failed', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}