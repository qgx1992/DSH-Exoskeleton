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
  /** 会话完成时发送原生通知（§4.2.3 任务完成） */
  notifySessionDone: boolean
  /** 首次启动引导是否已完成 */
  onboardingDone: boolean
  /** 内核使用模式：managed=托管内核优先，system=始终使用系统 dsh */
  kernelMode: 'managed' | 'system'
  /** 托管内核默认版本 */
  defaultKernelVersion: string | null
  /** 窗口几何记忆（尺寸/位置；null=首次启动用默认） */
  windowBounds: { width: number; height: number; x: number; y: number } | null
  /** 上次退出时窗口是否最大化 */
  windowMaximized: boolean
}

/** 托管 DSH 内核（多版本共存）信息 */
export interface KernelInfo {
  version: string
  dir: string
  status: 'installed' | 'downloading' | 'verifying' | 'installing' | 'error'
  installedAt: number | null
  size: number
  integrity: string | null
  error: string | null
}

/** 内核安装/操作进度推送 */
export interface KernelProgress {
  version: string
  stage: 'downloading' | 'verifying' | 'installing' | 'done' | 'error'
  percent: number
  message: string
}

/** 可用内核版本（npm registry） */
export interface KernelRemoteVersion {
  version: string
  publishedAt: string | null
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
  /** 下载进度（下载中） */
  progress: { percent: number; transferred: number; total: number } | null
  /** 下载完成待安装 */
  downloaded: boolean
  installing: boolean
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

/** 备份快照信息（§4.3.4 备份与回滚） */
export interface BackupInfo {
  /** 快照目录名（id） */
  id: string
  /** 显示名称 */
  name: string
  createdAt: number
  kind: 'manual' | 'auto'
  /** auto 快照的触发来源（插件安装/自动更新等） */
  trigger: string
  size: number
  entryCount: number
}

/** 社区插件目录条目（§4.3.3 插件管理器） */
export interface PluginCatalogItem {
  /** npm 包名（用于安装） */
  packageName: string
  /** 列表标题 */
  name: string
  description: string
  version: string | null
  stars: number
  url: string
  source: 'github' | 'npm'
}

export interface InstalledPlugin {
  name: string
  version: string
}

export interface PluginActionResult extends SaveResult {
  output?: string
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
  backup: {
    list: () => Promise<BackupInfo[]>
    create: (name?: string) => Promise<BackupInfo | null>
    restore: (id: string) => Promise<SaveResult>
    delete: (id: string) => Promise<SaveResult>
  }
  plugins: {
    catalog: (query?: string) => Promise<PluginCatalogItem[]>
    installed: () => Promise<InstalledPlugin[]>
    install: (pkg: string) => Promise<PluginActionResult>
    uninstall: (pkg: string) => Promise<PluginActionResult>
  }
  kernels: {
    installed: () => Promise<KernelInfo[]>
    available: () => Promise<KernelRemoteVersion[]>
    install: (version: string) => Promise<SaveResult>
    uninstall: (version: string) => Promise<SaveResult>
    setDefault: (version: string | null) => Promise<SaveResult>
    setMode: (mode: 'managed' | 'system') => Promise<SaveResult>
    /** 订阅安装/切换进度 */
    onProgress: (callback: (p: KernelProgress) => void) => () => void
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
    /** 显示/隐藏管理面板（隐藏时恢复显示 DSH Web UI 视图） */
    setAdminPanelVisible: (visible: boolean) => Promise<void>
  }
  updater: {
    check: () => Promise<UpdateInfo>
    install: () => Promise<void>
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