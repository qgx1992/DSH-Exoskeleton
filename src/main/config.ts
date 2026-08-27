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
  defaultPluginsProvisioned: false,
  kernelMode: 'managed',
  defaultKernelVersion: null,
  windowBounds: null,
  windowMaximized: false,
  activeProfileId: 'default',
  profiles: [{ id: 'default', name: '默认档案', kernelVersion: null, createdAt: Date.now() }],
  kernelsQuotaMB: 1024,
  kernelRegistry: ''
}

const ENCRYPTED_PREFIX = 'enc:'

class ConfigStore {
  private file = ''
  private cache: AppConfig | null = null
  /** R-16: 落盘防抖定时器（高频更新如窗口几何时合并写盘） */
  private persistTimer: NodeJS.Timeout | null = null

  init(): void {
    this.file = path.join(app.getPath('userData'), 'config.json')
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
        this.cache = this.normalize({ ...DEFAULTS, ...raw })
      } else {
        this.cache = this.normalize({ ...DEFAULTS })
        // R-16: 首次创建默认配置同步落盘（不等防抖）
        this.writeFile()
      }
    } catch (err) {
      logger.warn('config load failed, using defaults', err)
      this.cache = this.normalize({ ...DEFAULTS })
    }
  }

  /** 兼容老配置：补全 profile 列表，修复无效 activeProfileId（阶段 C） */
  private normalize(cfg: AppConfig): AppConfig {
    if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) {
      cfg.profiles = [{ id: 'default', name: '默认档案', kernelVersion: null, createdAt: Date.now() }]
    }
    if (!cfg.profiles.some((p) => p.id === cfg.activeProfileId)) {
      cfg.activeProfileId = cfg.profiles[0].id
    }
    return cfg
  }

  private persist(): void {
    // R-16: 异步防抖落盘（窗口拖动等高频 set 合并写盘，避免同步全量写阻塞主进程）
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.writeFile()
    }, 200)
  }

  /** R-16: 同步落盘（退出前调用，确保最后一次修改不丢失） */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      this.writeFile()
    }
  }

  private writeFile(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // R-3: 原子写入（临时文件 + rename），避免崩溃/断电写坏 config.json 导致配置回退默认
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      logger.error('config persist failed', err)
    }
  }

  /** 惰性初始化：任何调用都保证 userData 路径就绪（独立 bundle/测试环境未调 init 也能持久化） */
  private ensureInit(): void {
    if (!this.file) this.init()
  }

  get(): AppConfig {
    this.ensureInit()
    if (!this.cache) this.load()
    return { ...(this.cache as AppConfig) }
  }

  set(patch: Partial<AppConfig>): AppConfig {
    this.ensureInit()
    const next = { ...this.get(), ...patch }
    // apiKey 使用 OS 级加密存储（Windows DPAPI / macOS Keychain），避免明文落盘
    if (patch.apiKey !== undefined) {
      const current = this.cache?.apiKey
      // R-26: 明文与已存解密值相同 → 保持原密文，避免重复加密 + 全量写盘
      const samePlaintext =
        !!current &&
        current.startsWith(ENCRYPTED_PREFIX) &&
        patch.apiKey === this.getApiKey()
      if (samePlaintext) {
        next.apiKey = current
      } else {
        try {
          if (safeStorage.isEncryptionAvailable() && patch.apiKey && !patch.apiKey.startsWith(ENCRYPTED_PREFIX)) {
            const buf = safeStorage.encryptString(patch.apiKey)
            next.apiKey = ENCRYPTED_PREFIX + buf.toString('base64')
          }
        } catch (err) {
          logger.warn('apiKey encryption unavailable, storing as-is (local only)', err)
        }
      }
    }
    this.cache = next
    this.persist()
    logger.info('config updated', { keys: Object.keys(patch) })
    return this.get()
  }

  /** 读取解密后的 apiKey（P1 首次启动引导使用） */
  getApiKey(): string {
    this.ensureInit()
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
    this.ensureInit()
    return this.file
  }
}

export const configStore = new ConfigStore()