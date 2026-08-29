/**
 * @shared 主进程与渲染进程共享的类型定义
 * 对应开发文档 §6 API 设计
 */

/** DSH 服务状态 */
export type DSHStatus = 'starting' | 'running' | 'stopped' | 'error'

export interface DSHState {
  status: DSHStatus
  port: number | null
  /**
   * 当前进程打印的 Web UI 完整 URL（含认证 token，如 alpha 内核的
   * http://127.0.0.1:PORT/?token=…；老内核为纯端口地址）。WebContentsView
   * 必须用它首次访问以完成 cookie 签发，否则 alpha 内核返回 401
   * 「dsh web authentication required; reopen the URL printed by dsh web.」
   */
  webUrl: string | null
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
  /** 服务事件通知开关（保留原字段） */
  notifyServiceEvents: boolean
  /**
   * 会话完成通知粒度（设计 NOTIFICATION-PLUGIN-DESIGN.md §3.3）
   * - off：不通知；per-turn：每轮立即通知（现状行为）；aggregate：窗口内按会话 uuid 合并
   * 兼容旧 boolean：true→'per-turn'、false→'off'（config.ts 迁移）
   */
  notifySessionDone: 'off' | 'per-turn' | 'aggregate'
  /** 通知显示渠道：auto = webview 在线优先，否则 native（§3.3） */
  notifyChannel: 'auto' | 'native' | 'webview'
  /** 聚合窗口（ms）：同一会话 N ms 内多轮合并为「已完成 N 轮」（§3.3，默认 5000） */
  notifyAggregateWindowMs: number
  /** 首次启动引导是否已完成 */
  onboardingDone: boolean
  /** 内置默认插件是否已完成首装预置（true 后不再自动补装，尊重用户手动卸载） */
  defaultPluginsProvisioned: boolean
  /**
   * 首启默认内核预置是否已完成（阶段 D）：全新安装首次启动自动安装
   * DEFAULT_KERNEL_VERSION 并设为默认；true 后不再预置。老配置迁移时
   * 字段缺失视为 true（不打扰升级用户）；显式 false（预置未成功）保留重试
   */
  defaultKernelProvisioned: boolean
  /** 内核使用模式：managed=托管内核优先，system=始终使用系统 dsh */
  kernelMode: 'managed' | 'system'
  /** 托管内核默认版本 */
  defaultKernelVersion: string | null
  /** 窗口几何记忆（尺寸/位置；null=首次启动用默认） */
  windowBounds: { width: number; height: number; x: number; y: number } | null
  /** 上次退出时窗口是否最大化 */
  windowMaximized: boolean
  /** 激活的配置档案 id（阶段 C） */
  activeProfileId: string
  /** 配置档案列表（多 Profile，每档案可绑定内核版本） */
  profiles: DshProfile[]
  /** 内核仓库磁盘配额（MB，0 = 不限制） */
  kernelsQuotaMB: number
  /** 内核安装 registry 根（空 = 官方 npmjs；如 https://registry.npmmirror.com 加速国内） */
  kernelRegistry: string
}

/** 通知事件类型（设计 NOTIFICATION-PLUGIN-DESIGN.md §3.1，壳↔webview 桥与插件的契约） */
export type NotificationEventKind =
  | 'session-done' // 一轮对话完成
  | 'service-ready' // 服务就绪
  | 'service-error' // 服务异常
  | 'service-restarting' // 崩溃自动重启
  | 'update-ready' // 更新下载完成待安装
  | 'session-activate' // 控制类事件（非用户通知）：通知点击后的会话激活请求（webview 插件激活，不渲染 toast）

/** 通知事件（检测层产出的事实；显示是策略——由 notification-hub 选 Provider、插件渲染） */
export interface NotificationEvent {
  /** 事件唯一 ID（去重 / 回执 / 点击关联用） */
  id: string
  kind: NotificationEventKind
  title: string
  body: string
  ts: number
  /** 每类事件的附带载荷 */
  session?: {
    sessionDir: string
    workspace: string
    uuid: string
    file: string
    turn?: number
    project?: string
    sessionTitle?: string
    firstUserText?: string
  }
  service?: { port?: number; error?: string; restartCount?: number }
  update?: { version?: string }
  /** 原生 provider 专用：主进程侧点击动作（函数不可跨 IPC；webview 投递前剥离） */
  actions?: { onClick?: () => void }
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
  stage: 'downloading' | 'verifying' | 'installing' | 'extracting' | 'removing' | 'done' | 'error'
  percent: number
  message: string
}

/** 可用内核版本（npm registry） */
export interface KernelRemoteVersion {
  version: string
  publishedAt: string | null
}

/** 配置档案（阶段 C：多 Profile + 内核版本绑定） */
export interface DshProfile {
  id: string
  name: string
  /** 绑定内核版本；null = 跟随全局默认版本 */
  kernelVersion: string | null
  createdAt: number
}

/** 内置 Node 运行时状态（阶段 B） */
export interface RuntimeInfo {
  installed: boolean
  version: string | null
  /** 内置 node.exe 路径（未安装时为 null） */
  path: string | null
  /** 系统 Node（探测到的路径，未找到为 null） */
  systemNode: string | null
  /** 当前操作状态 */
  busy: 'idle' | 'downloading' | 'extracting' | 'removing'
}

/** 内核更新检测结果（阶段 B：channels latest/rc） */
export interface KernelUpdateInfo {
  /** 当前使用的内核版本（托管模式） */
  current: string | null
  /** registry dist-tags.latest（稳定版） */
  latest: string | null
  /** registry dist-tags.rc（预发布渠道） */
  rc: string | null
  /** 是否有可升级的新稳定版 */
  available: boolean
  /** 内核 registry 页面 */
  url: string | null
  checkedAt: number | null
  error: string | null
}

/** 内核/运行时存储统计（阶段 C：磁盘配额） */
export interface KernelQuota {
  /** 配额上限（MB；0 = 不限制） */
  quotaMB: number
  /** 已安装内核总占用（MB） */
  usedMB: number
  /** 内置 Node 运行时占用（MB） */
  runtimeMB: number
  /** 磁盘剩余空间（MB） */
  diskFreeMB: number
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
  /** 快照顶层条目（如 settings.yaml / profiles / plugins…），用于任选恢复 */
  entries: string[]
}

/** 会话摘要（~/.dsh/sessions/<workspace>/session-<uuid>/session.jsonl.zstd） */
export interface SessionInfo {
  /** 会话 uuid（目录名去 session- 前缀） */
  uuid: string
  /** 工作区目录名（DSH 内部编码形式，如 --C~3A--Users--...） */
  workspace: string
  /** 项目显示名（来自 cwd 最后一级，无 cwd 时由工作区名解码兜底） */
  project: string
  /** 会话标题（session/title 或首条用户消息截断） */
  title: string
  /** 首条用户消息（列表预览用） */
  firstUserText: string
  /** 会话数据文件绝对路径 */
  file: string
  /** 会话目录绝对路径 */
  sessionDir: string
  /** 文件大小（字节） */
  size: number
  /** 最近修改时间（ms） */
  modifiedAt: number
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
  /** 最近一次插件更新检测结果（null = 尚未检测） */
  update: PluginUpdateInfo | null
}

/** 插件更新检测结果（plugins:checkUpdate 逐插件产出） */
export interface PluginUpdateInfo {
  /** 声明 spec（profile package.json dependencies 原始值，如 ^1.2.3 / github:owner/repo / link:…） */
  declared: string
  /** 解析后实际安装版本（node_modules 内 package.json 的 version；读不到为 null） */
  current: string | null
  /** 远端最新版本（npm dist-tags.latest / GitHub 最新发布 tag；本地链接或不可检测为 null） */
  latest: string | null
  /** 是否有可升级的新版本（current 已知且 latest > current） */
  available: boolean
  /** 来源类型 */
  source: 'npm' | 'github' | 'local' | 'unknown'
  /** 本次检测时间（ms） */
  checkedAt: number
  /** 检测失败信息（网络受限等；正常为 null） */
  error: string | null
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
    clear: () => Promise<SaveResult>
  }
  backup: {
    list: () => Promise<BackupInfo[]>
    create: (name?: string) => Promise<BackupInfo | null>
    /** entries 为空/缺省 = 恢复全部顶层条目；指定则只恢复所选条目 */
    restore: (id: string, entries?: string[]) => Promise<SaveResult>
    delete: (id: string) => Promise<SaveResult>
  }
  plugins: {
    catalog: (query?: string) => Promise<PluginCatalogItem[]>
    installed: () => Promise<InstalledPlugin[]>
    install: (pkg: string) => Promise<PluginActionResult>
    uninstall: (pkg: string) => Promise<PluginActionResult>
    /** 联网检测全部已安装插件是否有新版本（返回附带 update 结果的已安装列表） */
    checkUpdate: () => Promise<InstalledPlugin[]>
    /** 升级插件到最新版（latest = 检测到的最新版本；npm 必须传精确版本，否则 range 内会 no-op） */
    upgrade: (name: string, latest?: string) => Promise<PluginActionResult>
  }
  kernels: {
    installed: () => Promise<KernelInfo[]>
    available: () => Promise<KernelRemoteVersion[]>
    /** registryOverride：内核安装 registry 根（空 = 官方 npmjs） */
    install: (version: string, registry?: string) => Promise<SaveResult>
    uninstall: (version: string) => Promise<SaveResult>
    setDefault: (version: string | null) => Promise<SaveResult>
    setMode: (mode: 'managed' | 'system') => Promise<SaveResult>
    /** 检查内核更新（dist-tags latest/rc） */
    checkUpdate: () => Promise<KernelUpdateInfo>
    /** 内核/运行时存储统计（配额） */
    quota: () => Promise<KernelQuota>
    /** 订阅安装/切换进度 */
    onProgress: (callback: (p: KernelProgress) => void) => () => void
  }
  runtime: {
    /** 内置 Node 运行时状态 */
    status: () => Promise<RuntimeInfo>
    /** 下载并安装内置 Node 运行时（后台，进度走 runtime:progress） */
    download: () => Promise<SaveResult>
    /** 删除内置 Node 运行时 */
    remove: () => Promise<SaveResult>
    /** 订阅下载/解压进度 */
    onProgress: (callback: (p: KernelProgress) => void) => () => void
  }
  profiles: {
    list: () => Promise<DshProfile[]>
    /** 新建档案（返回新建的档案） */
    create: (name: string) => Promise<SaveResult & { profile?: DshProfile }>
    /** 删除档案（default 档案不可删） */
    delete: (id: string) => Promise<SaveResult>
    /** 激活档案（切换后服务自动重启换内核） */
    activate: (id: string) => Promise<SaveResult>
    /** 绑定/解除档案的内核版本 */
    setKernel: (id: string, version: string | null) => Promise<SaveResult>
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
  sessions: {
    /** 列出 ~/.dsh/sessions 下会话摘要（按修改时间倒序） */
    list: (limit?: number) => Promise<SessionInfo[]>
    /** 在 DSH Web UI 中打开会话（唤起窗口并定位） */
    open: (uuid: string) => Promise<SaveResult>
    /** 删除会话目录（含 session.jsonl.zstd） */
    remove: (uuid: string) => Promise<SaveResult>
    /** 导出会话数据文件（用户选择保存位置后复制） */
    export: (uuid: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    /** 在系统资源管理器中显示会话数据文件 */
    show: (uuid: string) => Promise<SaveResult>
  }
  notify: {
    /** 发送一条系统测试通知（验证通知是否可达） */
    test: () => Promise<{ ok: boolean }>
  }
  logs: {
    list: (limit?: number) => Promise<LogEntry[]>
    openDir: () => Promise<void>
  }
  app: {
    getVersion: () => Promise<string>
    getDshHome: () => Promise<string | null>
    openExternal: (url: string) => Promise<void>
    /** 复制文本到系统剪贴板（面板复制 Web UI 地址等） */
    copyText: (text: string) => Promise<void>
  }
}
