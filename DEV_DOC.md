# DeepSeek Harness 桌面端开发文档

> 基于社区 7 个 DSH 桌面端项目的调研分析，制定的统一开发方案


## 一、项目概述

### 1.1 项目背景

DeepSeek Harness（DSH）是 DeepSeek 官方的 Agent 框架，原生提供 Web UI（`dsh web`），但日常使用仍需在终端中手动启动和管理服务[reference:0]。社区涌现了大量桌面封装方案，将 DSH Web UI 打包为可直接双击运行的桌面程序[reference:1]。

本项目旨在吸收各方案的优点，打造一个**轻量、纯净、功能完整**的 DSH 桌面客户端。

### 1.2 项目目标

| 维度 | 目标 |
| :--- | :--- |
| **零门槛** | 下载安装即用，无需预装 Node.js / pnpm |
| **不动本体** | 不改 DSH 源码，官方升级无缝跟随[reference:2] |
| **数据复用** | 默认共用 `~/.dsh`，已有配置零迁移[reference:3] |
| **原生体验** | 系统托盘、原生通知、单实例、开机自启[reference:4] |
| **轻量高效** | 安装包小、内存占用低 |

### 1.3 参考项目

| 项目 | 核心亮点 |
| :--- | :--- |
| dsh-clean-desktop-shell | DSH 插件形态，纯净窗口壳，零视觉改造[reference:5] |
| DSHDesktop (CCMu04) | 零前端分叉，无缝衔接 `~/.dsh`[reference:6] |
| dsh-desktop (SnowCrescenter) | 原生 Windows 体验，无边框窗口，自动更新[reference:7] |
| dsh-desktop (kevenxz) | 轻量封装，数据复用，安全隔离[reference:8] |
| dsh-desktop (csyyywy) | 壳核分离，插件管理器，备份回滚[reference:9] |
| deepseek-harness-desktop (Tauri) | Tauri 2 超轻量，安装包仅 5MB[reference:10] |
| anywhere-labs/dsh-desktop | 「万物皆插件」生态型桌面[reference:11] |


## 二、技术选型

### 2.1 技术栈总览

| 层级 | 技术 | 选型理由 |
| :--- | :--- | :--- |
| **桌面框架** | Electron | 社区方案最成熟，7 个项目中有 6 个采用 Electron |
| **备选框架** | Tauri 2 | 如需极致轻量（<10MB）可考虑，生态相对年轻[reference:12] |
| **语言** | TypeScript | 类型安全，大型项目可维护性高 |
| **渲染层** | React + Tailwind CSS | 外壳 UI 开发效率高[reference:13] |
| **构建工具** | Vite + electron-builder | 开发热更新快，打包配置灵活[reference:14] |
| **打包分发** | NSIS + Portable | 同时提供安装版和免安装单文件版[reference:15] |

### 2.2 目录结构

```
dsh-desktop/
├── src/
│   ├── main/                 # Electron 主进程
│   │   ├── index.ts          # 入口：窗口/生命周期
│   │   ├── tray.ts           # 系统托盘
│   │   ├── dsh-manager.ts    # DSH 子进程管理（启动/停止/健康检查）
│   │   ├── updater.ts        # 自动更新
│   │   └── ipc-handlers.ts   # IPC 通信
│   ├── preload/              # contextBridge 类型化桥接[reference:16]
│   │   └── index.ts
│   └── renderer/             # 外壳 UI
│       ├── App.tsx           # 主界面（splash + 仪表盘）
│       ├── components/       # React 组件
│       └── styles/           # Tailwind 样式
├── resources/                # 资源文件（图标等）[reference:17]
├── scripts/                  # 构建脚本[reference:18]
├── data/                     # 运行时数据（绿色版位于 exe 同级）[reference:19]
├── electron-builder.yml      # 打包配置[reference:20]
├── package.json
└── tsconfig.json
```


## 三、架构设计

### 3.1 整体架构

项目遵循 **「壳核分离」** 原则[reference:21]：

```
┌─────────────────────────────────────────────────────────┐
│                   Electron 桌面壳                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  窗口管理   │  │  系统托盘   │  │  自动更新   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ DSH进程管理  │  │  配置管理   │  │  插件管理   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
├─────────────────────────────────────────────────────────┤
│                    DSH 内核（不修改）                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  dsh web   │  │  Agent引擎  │  │  插件系统   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
│                    ~/.dsh （数据复用）                   │
└─────────────────────────────────────────────────────────┘
```

### 3.2 核心模块说明

| 模块 | 职责 | 参考实现 |
| :--- | :--- | :--- |
| **DSH 进程管理** | 启动/停止 `dsh web` 子进程，健康检查，崩溃自动重启 | kevenxz[reference:22] |
| **窗口管理** | 无边框/自绘标题栏、窗口状态指示、单实例 | SnowCrescenter[reference:23] |
| **系统托盘** | 单击唤回、右键菜单（打开/退出/设置/日志） | 全部项目 |
| **配置管理** | API Key、端口、工作区、开机自启 | csyyywy[reference:24] |
| **自动更新** | 后台静默检查、下载就绪后通知重启 | SnowCrescenter[reference:25] |
| **插件管理** | 浏览/搜索/安装/卸载社区插件 | csyyywy[reference:26] |
| **内核管理** | 多版本共存：npm 安装/校验/默认路由/卸载（kernel-manager.ts） | 自研 |
| **运行时管理** | 内置 Node 运行时下载/自检/删除（runtime-manager.ts，阶段 B） | 自研 |
| **配置档案** | 多 Profile + 内核版本绑定（profiles.ts，阶段 C） | 自研 |


## 四、功能模块详细设计

### 4.1 P0 — 基础可用（MVP）

#### 4.1.1 DSH 子进程管理

**功能**：启动、停止、重启 `dsh web` 子进程，健康检查，崩溃自动恢复。

**实现要点**：
- 使用 `child_process.spawn` 启动 `dsh web --port 0`[reference:27]
- `--port 0` 让系统自动分配空闲端口，天然避免冲突[reference:28]
- 定期向 `http://127.0.0.1:{port}/health` 发送请求进行健康检查
- 进程崩溃时自动重启，并通知前端[reference:29]

**接口**：
```typescript
interface DSHManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  getStatus(): 'starting' | 'running' | 'stopped' | 'error';
  getPort(): number;
  onStatusChange(callback: (status: string) => void): void;
}
```

#### 4.1.2 原生窗口

**功能**：无边框窗口、自绘标题栏、实时状态指示[reference:30]。

**实现要点**：
- `frame: false` 移除系统默认边框
- 36px 自绘标题栏：窗口控制按钮（最小化/最大化/关闭）+ 状态点
- 状态点颜色：青色 = 服务运行中，灰色 = 启动中，红色 = 出错[reference:31]
- Windows 11 下窗口圆角由 DWM 原生渲染[reference:32]

**Electron 配置**：
```javascript
// main/index.ts
const win = new BrowserWindow({
  width: 1200,
  height: 800,
  frame: false,
  titleBarStyle: 'hidden',
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    sandbox: true,           // 安全隔离[reference:33]
    nodeIntegration: false,  // 禁止 Node.js 集成[reference:34]
    contextIsolation: true,
  }
});
```

#### 4.1.3 系统托盘

**功能**：程序常驻后台，单击唤回窗口，右键菜单齐全[reference:35]。

**右键菜单**：
- 打开主界面
- 启动/停止 DSH 服务
- 开机自启（复选）[reference:36]
- 打开日志目录[reference:37]
- 检查更新
- 关于
- 退出

**实现要点**：
- 关闭窗口时隐藏而非退出（`win.hide()`）[reference:38]
- 托盘单击唤回窗口（`win.show()`）

#### 4.1.4 单实例运行

**功能**：同一时间只允许一个实例运行，重复双击唤出已有窗口[reference:39]。

**实现**：
```javascript
import { app } from 'electron';
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) { win.show(); win.focus(); }
  });
}
```

### 4.2 P1 — 用户体验增强

#### 4.2.1 首次启动引导

**功能**：首次运行弹出向导，引导输入 DeepSeek API Key[reference:40]。

**实现要点**：
- 检测 `~/.dsh/.env` 或 `~/.dsh/profiles/web/.env` 是否存在 API Key
- 若无，弹出向导对话框
- Key 仅保存在本地，不联网上传[reference:41]

#### 4.2.2 数据复用

**功能**：默认共用 `~/.dsh` 目录，已有配置零迁移[reference:42]。

**数据规则**（遵循官方 DSH Home 规则）[reference:43]：
1. 若设置了非空的 `DSH_HOME` 环境变量，使用该目录
2. 否则使用 `%USERPROFILE%\.dsh`

**目录说明**[reference:44]：
- `~/.dsh/plugins` — 用户插件
- `~/.dsh/profiles/web` — Web Profile 安装记录
- `~/.dsh/sessions` — 会话数据

#### 4.2.3 原生通知

**功能**：任务完成、更新就绪等场景发送 Windows 原生通知[reference:45]。

**实现要点**：
- 使用 Electron 的 `Notification` API
- 系统不支持时自动降级为托盘气泡[reference:46]

**对话完成判定语义**（`session-watcher.ts`）：
- DSH 的 `turn/end` 表示「一轮对话结束」；会话（session）可包含多轮——
  **每轮结束（非 interrupted）即立即通知**，不做会话级聚合，每一轮都是独立提醒
- 按轮（`turn/end` 的 `data.turn` 编号）去重：同一轮只通知一次（DSH 崩溃修复可能重写重复 turn/end）
- `turn/end(interrupted)` 是崩溃恢复时持久层合成的关闭标记（loop 从不主动发出），不代表一轮正常完成，不参与通知
- 无 `turn/end` 的会话（未完成任何一轮/中途异常退出）不通知——没有结束标记就静默，宁可漏报不可误报（不使用「停止写入」兜底）
- 通知标题「DSH 对话完成」，正文带项目/标题/轮次（第 N 轮）
- watcher 启动前已存在的旧会话（基线）不误报

**点击通知跳转会话**（`window-manager.ts` `activateSessionInWebUi`）：
- 优先按**会话 ID 精确匹配**：从会话行 DOM 元素的 React fiber（`__reactFiber$` 属性）向上读取
  `node.id`（会话 uuid），消除同标题会话误点
- fiber 读取失败或 ID 不存在时依次回退：标题模糊匹配 → 「刚刚/N秒前」时间兜底
- 点击后验证选中态（ID 或标题），未切换则重试（最多 4 轮），SPA 结构变化时静默失败

#### 4.2.4 安全隔离

**功能**：仅监听本地回环地址，启用渲染进程沙箱[reference:47]。

**实现要点**：
- Web 服务仅监听 `127.0.0.1`（而非 `0.0.0.0`）[reference:48]
- 渲染进程启用沙箱（`sandbox: true`）
- 禁用 Node.js 集成（`nodeIntegration: false`）[reference:49]

### 4.3 P2 — 高级功能

#### 4.3.1 自动更新

**功能**：后台静默检查新版本，下载就绪后通知用户重启[reference:50]。

**实现**：
- 使用 `electron-updater` 配合 GitHub Releases
- 安装版（NSIS）：后台静默下载，完成后弹窗通知[reference:51]
- 便携版：仅提示有更新，引导用户手动下载替换[reference:52]

#### 4.3.2 仪表盘

**功能**：统一的管理界面，包含状态、设置、更新、日志、插件管理[reference:53]。

**面板**：
| 面板 | 内容 |
| :--- | :--- |
| **状态** | DSH 运行状态、端口、版本 |
| **设置** | 端口、工作区、API Key、开机自启[reference:54] |
| **更新** | 一键升级 + 历史版本回滚[reference:55] |
| **日志** | 实时日志查看[reference:56] |
| **插件管理** | 浏览/搜索/安装/卸载[reference:57] |

#### 4.3.3 插件管理器

**功能**：浏览、搜索、一键安装/卸载社区插件[reference:58]。

**实现要点**：
- 从 GitHub topic `dsh-plugin` 或 npm `dsh-plugin` 拉取插件列表[reference:59]
- 安装前冲突预检（同名/重复注册先报告）[reference:60]
- 内置 pnpm，离线可用[reference:61]
- 每次安装/卸载前自动备份[reference:62]

#### 4.3.3.1 推荐插件与默认启用预置

**推荐插件集**（`src/shared/recommended-plugins.ts` 的 `RECOMMENDED_PLUGINS`）：
- 管理面板「插件」页的「推荐插件」区展示，支持单个/批量一键安装（复用 §4.3.3 安装链路，装完自动注册 bundles）；
- 条目字段：`installTarget`（传给 `dsh plugin --profile web add`）、`name`（用于「已安装」判断，匹配 profile 依赖 key）、`description`、`source`（npm/github）、`url`（主页）、`defaultEnabled`（可选：内置默认启用标记）。

**默认启用预置**（`src/main/plugins.ts` 的 `provisionDefaultPlugins`）：
- 在 DSH 服务首次就绪（statusChange → running，web profile 已由内核初始化）后触发，幂等：检查 profile 的 dependencies 与 `dsh.profile.bundles`，缺则自动 `dsh plugin add`（装完自动注册 bundles = 默认启用，仅需一次重启加载）；
- 只执行一次：成功后写 `config.defaultPluginsProvisioned = true`；失败不落标记，下次服务就绪自动重试；预置完成后用户手动卸载也不会被强制补装，尊重用户选择；
- 默认启用清单 = `RECOMMENDED_PLUGINS.filter(p => p.defaultEnabled)`。

**已知问题：pnpm 供应链策略阻塞插件安装/卸载**
- 若 profile 的 `pnpm-workspace.yaml` 启用了 `minimumReleaseAge` 策略（并配 `minimumReleaseAgeExclude` 白名单），任何 `dsh plugin add/remove` 都会先做 lockfile 供应链校验；
- 某依赖版本发布不足策略期限（默认 24h）且不在白名单时，操作报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 直接失败——表现为"面板里安装/卸载点了没反应"（包括 dshmarket 的装/卸）；
- 处理：把对应版本加入 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（如 `- dsh-cost-meter@1.6.7`）后重试，或等待超过策略期限；与策略无关的临时停用可走 profile 补丁（`cordis.patch.yml` 加 `- id: <entryId>` + `disabled: true`）。

#### 4.3.4 备份与回滚

**功能**：手动存档 + 自动快照，支持版本回退[reference:63]。

**实现要点**：
- 关键操作（更新、插件安装）前自动创建快照
- 用户可手动创建存档
- 一键回退到指定版本


## 五、开发路线图

### Phase 1 — MVP（2-3 周）

| 任务 | 说明 |
| :--- | :--- |
| 项目脚手架 | Electron + TypeScript + React + Vite |
| 原生窗口 | 无边框窗口 + 自绘标题栏 + 状态点 |
| 系统托盘 | 托盘常驻 + 右键菜单 |
| 单实例 | 防止重复启动 |
| DSH 进程管理 | 启动/停止 `dsh web`，健康检查 |
| 端口自动分配 | `--port 0` 自动分配空闲端口[reference:64] |

**里程碑**：可双击启动，看到 DSH Web UI 在原生窗口中运行。

### Phase 2 — 体验完善（2-3 周）

| 任务 | 说明 |
| :--- | :--- |
| 首次启动引导 | API Key 输入向导[reference:65] |
| 数据复用 | 共用 `~/.dsh`，零迁移[reference:66] |
| 原生通知 | Windows 原生通知样式[reference:67] |
| 开机自启 | 可选，登录后后台静默启动[reference:68] |
| 安全隔离 | 127.0.0.1 + 沙箱 + 禁用 Node.js 集成[reference:69] |
| 日志查看 | 托盘菜单一键打开日志目录[reference:70] |

**里程碑**：完整的桌面应用体验，非技术用户可零门槛使用。

### Phase 3 — 高级功能（2-3 周）

| 任务 | 说明 |
| :--- | :--- |
| 自动更新 | 后台静默检查 + 下载 + 通知重启[reference:71] |
| 仪表盘 | 状态/设置/更新/日志统一面板[reference:72] |
| 插件管理器 | 浏览/搜索/安装/卸载[reference:73] |
| 备份与回滚 | 手动存档 + 自动快照[reference:74] |
| 三种分发形态 | NSIS 安装包 + Portable 单文件版 + 绿色版[reference:75] |

**里程碑**：功能完整的 DSH 桌面客户端，可与主流方案媲美。

### 内核管理（阶段 A/B/C，已落地）

| 阶段 | 内容 | 落地 |
| :--- | :--- | :--- |
| A | KernelManager：npm 下载/校验/安装到 userData/kernels/、默认路由、卸载 | v0.3.0 |
| B | 内置 Node 运行时（runtime-manager.ts：一键下载/解压/自检，resolveNode 优先）；内核更新检测（dist-tags latest/rc）+ 一键升级；进度推送 | v0.6.0 |
| C | 多 Profile 档案（profiles.ts + 档案面板）：档案绑定内核版本、切换即换内核；卸载引用保护；磁盘配额（kernelsQuotaMB） | v0.6.0 |

**验收**：全新机器仅装应用 → 下载内置 Node 运行时 + 托管内核 → 打开 DSH Web UI；不同档案稳定运行不同内核版本。

### Phase 4 — 生态建设（持续）

| 任务 | 说明 |
| :--- | :--- |
| 多 Profile 支持 | 新建/切换/删除隔离的配置档案[reference:76] |
| 插件市场集成 | 与社区插件生态打通[reference:77] |
| 跨平台支持 | macOS / Linux（基于 Tauri 或 Electron 跨平台打包） |
| 社区贡献指南 | 完善的文档和贡献流程[reference:78] |


## 六、API 设计

### 6.1 IPC 通信（主进程 ↔ 渲染进程）

```typescript
// preload/index.ts - 暴露给渲染进程的 API
const api = {
  // DSH 管理
  dsh: {
    start: () => ipcRenderer.invoke('dsh:start'),
    stop: () => ipcRenderer.invoke('dsh:stop'),
    restart: () => ipcRenderer.invoke('dsh:restart'),
    getStatus: () => ipcRenderer.invoke('dsh:getStatus'),
    getPort: () => ipcRenderer.invoke('dsh:getPort'),
    onStatusChange: (callback: (status: string) => void) => {
      ipcRenderer.on('dsh:statusChange', (_, status) => callback(status));
    },
  },
  // 配置
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
  },
  // 托盘
  tray: {
    show: () => ipcRenderer.invoke('tray:show'),
    hide: () => ipcRenderer.invoke('tray:hide'),
  },
  // 更新
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStatus: (callback: (status: string) => void) => {
      ipcRenderer.on('updater:status', (_, status) => callback(status));
    },
  },
};
```

### 6.2 配置项

| 配置项 | 用途 | 默认值 | 来源 |
| :--- | :--- | :--- | :--- |
| `port` | 固定 Web 服务端口 | 自动选择空闲端口 | kevenxz[reference:79] |
| `workspace` | Agent 工作区目录 | `%USERPROFILE%\DSHWorkspace` | kevenxz[reference:80] |
| `autoLaunch` | 开机自启 | `false` | SnowCrescenter[reference:81] |
| `apiKey` | DeepSeek API Key | 空 | SnowCrescenter[reference:82] |


## 七、构建与分发

### 7.1 构建命令

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 类型检查
npm run typecheck

# 单元测试
npm test

# 构建三种形态[reference:83]
npm run dist
# 产出：
#   dist/win-unpacked/          # 免安装绿色版文件夹
#   dist/DeepSeek-Harness-Setup-x64.exe  # NSIS 安装器
#   dist/DeepSeek-Harness-Portable-x64.exe # 单文件便携版
```

### 7.2 分发形态

| 形态 | 适用场景 | 特点 |
| :--- | :--- | :--- |
| **NSIS 安装包** | 推荐给大多数用户 | 开始菜单快捷方式、桌面快捷方式、卸载程序[reference:84] |
| **Portable 单文件版** | 适合 U 盘携带 | 免安装，解压即用[reference:85] |
| **绿色版文件夹** | 适合高级用户 | 解压即用，便于调试[reference:86] |

### 7.3 首次启动流程

1. 应用启动，显示 Splash 界面
2. 检测 `~/.dsh` 是否存在以及是否包含有效配置
3. 若首次启动且无 API Key，弹出引导向导[reference:87]
4. 启动 `dsh web --port 0` 子进程[reference:88]
5. 健康检查通过后，加载 `http://127.0.0.1:{port}`
6. 窗口显示 DSH Web UI


## 八、质量保障

### 8.1 测试策略

| 测试层级 | 工具 | 覆盖范围 |
| :--- | :--- | :--- |
| 单元测试 | Vitest | 核心逻辑模块[reference:89] |
| 集成测试 | Playwright | 窗口加载、DSH 启动流程 |
| 冒烟测试 | 脚本 | 页面加载成功后自动退出[reference:90] |

### 8.2 日志规范

日志位置：`%APPDATA%\DeepSeek Harness\dsh-desktop.log`[reference:91]

日志内容：启动/停止事件、进程状态变化、错误堆栈、更新记录

> ⚠️ 日志可能包含工作区路径和运行信息，公开前请检查敏感内容[reference:92]


## 九、参考资源

### 9.1 参考项目

| 项目 | 链接 |
| :--- | :--- |
| dsh-clean-desktop-shell | https://github.com/Icather/dsh-clean-desktop-shell |
| DSHDesktop (CCMu04) | https://github.com/CCMu04/DSHDesktop |
| dsh-desktop (SnowCrescenter) | https://github.com/SnowCrescenter-tech/dsh-desktop |
| dsh-desktop (kevenxz) | https://github.com/kevenxz/dsh-desktop |
| dsh-desktop (csyyywy) | https://github.com/csyyywy/dsh-desktop |
| deepseek-harness-desktop (Tauri) | https://github.com/dsh-tauri-desk/deepseek-harness-desktop |
| anywhere-labs/dsh-desktop | https://github.com/anywhere-labs/deepseek-harness-desktop |

### 9.2 官方资源

- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- DSH 插件生态倡议书: https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/plugin-ecosystem.md[reference:93]
