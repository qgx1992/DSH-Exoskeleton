/**
 * 配置管理：存储于 userData/config.json
 * 对应开发文档 §6.2 配置项
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger'
import type { AppConfig } from '../shared/types'

const DEFAULTS: AppConfig = {
  port: 0,
  workspace: '',
  autoLaunch: false,
  apiKey: '',
  dshHome: '',
  minimizeToTray: true,
  autoStartService: true,
  notifyServiceEvents: true,
  notifySessionDone: true,
  onboardingDone: false,
  kernelMode: 'managed',
  defaultKernelVersion: null,
  windowBounds: null,
  windowMaximized: false
}

const ENCRYPTED_PREFIX = 'enc:'

class ConfigStore {
  private file = ''
  private cache: AppConfig | null = null

  init(): void {
    this.file = path.join(app.getPath('userData'), 'config.json')
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
        this.cache = { ...DEFAULTS, ...raw }
      } else {
        this.cache = { ...DEFAULTS }
        this.persist()
      }
    } catch (err) {
      logger.warn('config load failed, using defaults', err)
      this.cache = { ...DEFAULTS }
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      logger.error('config persist failed', err)
    }
  }

  get(): AppConfig {
    if (!this.cache) this.load()
    return { ...(this.cache as AppConfig) }
  }

  set(patch: Partial<AppConfig>): AppConfig {
    const next = { ...this.get(), ...patch }
    // apiKey 使用 OS 级加密存储（Windows DPAPI / macOS Keychain），避免明文落盘
    if (patch.apiKey !== undefined) {
      try {
        if (safeStorage.isEncryptionAvailable() && patch.apiKey && !patch.apiKey.startsWith(ENCRYPTED_PREFIX)) {
          const buf = safeStorage.encryptString(patch.apiKey)
          next.apiKey = ENCRYPTED_PREFIX + buf.toString('base64')
        }
      } catch (err) {
        logger.warn('apiKey encryption unavailable, storing as-is (local only)', err)
      }
    }
    this.cache = next
    this.persist()
    logger.info('config updated', { keys: Object.keys(patch) })
    return this.get()
  }

  /** 读取解密后的 apiKey（P1 首次启动引导使用） */
  getApiKey(): string {
    const key = this.get().apiKey
    if (!key) return ''
    if (key.startsWith(ENCRYPTED_PREFIX)) {
      try {
        const buf = Buffer.from(key.slice(ENCRYPTED_PREFIX.length), 'base64')
        return safeStorage.decryptString(buf)
      } catch (err) {
        logger.error('apiKey decrypt failed', err)
        return ''
      }
    }
    return key
  }

  hasApiKey(): boolean {
    return this.getApiKey().length > 0
  }

  getFile(): string {
    return this.file
  }
}

export const configStore = new ConfigStore()