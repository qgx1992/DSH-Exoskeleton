/**
 * @shared 主进程与渲染进程共享的类型定义
 * 对应开发文档 §6 API 设计
 */

/** DSH 服务状态 */
export type DSHStatus = 'starting' | 'running' | 'stopped' | 'error'

export interface DSHState {
  status: DSHStatus
  port: number | null
  version: string | null
  dshHome: string | null
  pid: number | null
  startedAt: number | null
  lastError: string | null
  /** 自上次启动以来的崩溃重启次数 */
  restartCount: number
}

/** 应用配置（存储于 userData/config.json） */
export interface AppConfig {
  /** 固定 Web 服务端口；0 = 自动选择空闲端口 */
  port: number
  /** Agent 工作区目录（预留） */
  workspace: string
  /** 开机自启 */
  autoLaunch: boolean
  /** DeepSeek API Key（仅本地保存，P1 加密） */
  apiKey: string
  /** DSH Home 目录覆盖；空 = 遵循官方规则（DSH_HOME / %USERPROFILE%\.dsh） */
  dshHome: string
  /** 是否隐藏托盘图标（预留） */
  minimizeToTray: boolean
  /** 应用启动时自动启动 DSH 服务 */
  autoStartService: boolean
  /** 服务状态变化时发送原生通知 */
  notifyServiceEvents: boolean
  /** 首次启动引导是否已完成 */
  onboardingDone: boolean
}

/** 日志条目 */
export interface LogEntry {
  time: number
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

/** 更新检查结果 */
export interface UpdateInfo {
  current: string
  latest: string | null
  available: boolean
  url: string | null
  checkedAt: number | null
  error: string | null
}

/** 首次启动引导状态 */
export interface SetupStatus {
  configured: boolean
  file: string
  refs: string[]
  malformed: boolean
}

export interface SaveResult {
  ok: boolean
  error?: string
}

/** 预加载桥接暴露给渲染进程的 API（文档 §6.1） */
export interface DesktopApi {
  dsh: {
    start: () => Promise<SaveResult>
    stop: () => Promise<SaveResult>
    restart: () => Promise<SaveResult>
    getState: () => Promise<DSHState>
    /** 订阅状态变化，返回取消函数 */
    onStateChange: (callback: (state: DSHState) => void) => () => void
  }
  setup: {
    check: () => Promise<SetupStatus>
    save: (apiKey: string) => Promise<SaveResult>
  }
  config: {
    get: () => Promise<AppConfig>
    set: (patch: Partial<AppConfig>) => Promise<AppConfig>
  }
  tray: {
    show: () => Promise<void>
    hide: () => Promise<void>
  }
  window: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onMaximizeChange: (callback: (maximized: boolean) => void) => () => void
  }
  updater: {
    check: () => Promise<UpdateInfo>
    onStatus: (callback: (info: UpdateInfo) => void) => () => void
  }
  logs: {
    list: (limit?: number) => Promise<LogEntry[]>
    openDir: () => Promise<void>
  }
  app: {
    getVersion: () => Promise<string>
    getDshHome: () => Promise<string | null>
    openExternal: (url: string) => Promise<void>
  }
}