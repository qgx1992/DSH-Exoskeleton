# 01 · 概念与术语

> 本页按"从外到内"的顺序解释：先讲 DSH 生态，再讲本仓库这个外壳，最后讲 Electron 技术细节。
> 每一条都标注"在仓库里对应哪里"，方便你边读边找代码。

## 一、DSH 生态（外部世界）

| 术语 | 含义 | 说明 |
| :--- | :--- | :--- |
| **DeepSeek Harness（DSH）** | DeepSeek 官方的 Agent 框架 | 提供 CLI（`dsh`）与 Web UI（`dsh web`）。官方仓库：`deepseek-ai/deepseek-harness` |
| **dsh web** | DSH 的 Web 界面服务 | 本仓库的核心动作就是 `spawn dsh web --port 0`，让它在本地端口跑起来，再把界面嵌进桌面窗口 |
| **~/.dsh（DSH_HOME）** | DSH 的数据目录 | 存放配置、会话、凭据、profiles。桌面端默认复用 `%USERPROFILE%\.dsh`，**已有配置零迁移**；`DSH_HOME` 环境变量可覆盖 |
| **内核（kernel）** | DSH 框架本体（npm 包 `@deepseek-ai/dsh`） | 桌面端支持**多版本共存**：下载、设默认、卸载，每个版本约 50MB+。默认预置版本见 `src/shared/kernel-defaults.ts` |
| **profile** | DSH 的配置档案 | 一个 profile = 一套独立配置 + 已装插件。桌面端默认操作 `~/.dsh/profiles/web/`；多档案可绑定不同内核版本（`src/main/profiles.ts`） |
| **插件（plugin）** | 扩展 DSH Web UI 的第三方包 | 来源：GitHub `dsh-plugin` topic + npm。桌面端转发 `dsh plugin --profile web add|remove` 安装，见 `src/main/plugins.ts` |
| **bundles** | profile 里的**插件启用清单** | 在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 字段——写进 bundles 才算启用 |
| **cordis.patch.yml** | profile 的用户补丁层 | 可临时停用插件（`disabled: true`），格式必须是带 `id` 的字段写法 |
| **API Key / .credentials.yaml** | DeepSeek API 凭据 | 存于 `~/.dsh/.credentials.yaml`（仓库外），桌面端首次启动向导负责引导写入；**严禁硬编码进代码** |

## 二、本仓库这个"外壳"（壳核分离）

| 术语 | 含义 | 对应代码 |
| :--- | :--- | :--- |
| **壳核分离** | 桌面端绝不修改 DSH 内核源码，只做"壳" | 内核由桌面端下载托管，官方升级无缝跟随 |
| **DSH 子进程管理** | 启动/停止/健康检查/崩溃自动重启 `dsh web` | `src/main/dsh-manager.ts`（退避 3s→60s，MAX_RESTARTS 上限） |
| **管理仪表盘（Dashboard）** | 状态/设置/内核/档案/插件/备份/日志/更新 的本地控制台 | `src/renderer/`（React + Tailwind） |
| **配置存储** | 桌面端自己的配置 | `%APPDATA%\DSH-Exoskeleton\config.json`，见 `src/main/config.ts`（原子写 + 防抖落盘，apiKey 用 DPAPI 加密） |
| **日志** | 桌面端运行日志 | `%APPDATA%\DSH-Exoskeleton\dsh-desktop.log`（2MB 轮转），见 `src/main/logger.ts` |
| **备份与回滚** | 插件操作前自动快照 + 手动存档 | `src/main/backup.ts`，快照存 `userData\backups` |
| **关键不变量（R-N）** | 代码注释里的硬约束，改动前必须 grep | 完整清单见 [AGENT.md §4](../../AGENT.md)（如 R-2 退出强杀 dsh 进程树、R-11 下载完整性校验） |

## 三、Electron 技术细节

| 术语 | 含义 | 在本仓库的对应 |
| :--- | :--- | :--- |
| **主进程（main）** | Electron 的 Node 侧进程，负责系统能力 | `src/main/`（22 个模块） |
| **渲染进程（renderer）** | 跑网页 UI 的进程 | `src/renderer/`（外壳仪表盘 UI） |
| **preload** | 主/渲染进程间的安全桥，暴露白名单 API | `src/preload/index.ts`（`window.dshDesktop.*`）、`src/preload/dsh-view.ts`（`window.__dshExo`，DSH Web 视图专用） |
| **contextBridge / IPC** | 跨进程通信的机制 | 通道注册在 `src/main/ipc-handlers.ts`，类型契约在 `src/shared/types.ts`（单一事实源） |
| **WebContentsView** | 在窗口里嵌入另一个网页视图的组件 | `src/main/window-manager.ts`——用它把 **DSH Web UI** 嵌进主窗口 |
| **无边框窗口 + 自绘标题栏** | 窗口无系统边框，标题栏自己画 | `src/renderer/components/TitleBar.tsx`，状态点：青=运行 / 灰=启动 / 红=异常 |
| **系统托盘** | 最小化到托盘，单击唤回 | `src/main/tray.ts` |
| **单实例** | 重复双击唤出已有窗口而非再开一个 | `src/main/index.ts`（单实例锁） |
| **electron-vite** | 构建工具（Vite + Electron 集成） | `electron.vite.config.ts`，`npm run dev` 热更渲染层 |
| **electron-builder** | 打包工具 | `electron-builder.yml`，产物：NSIS 安装版 + 单文件便携版 + win-unpacked |

## 四、一句话总结数据流

```
桌面外壳（main）启动 → spawn dsh web（内核）→ 健康检查通过
→ WebContentsView 把 DSH Web UI 嵌进窗口
→ 你在窗口里操作 DSH 会话
→ 外壳通过 IPC / preload 给仪表盘提供状态、日志、内核、插件等管理能力
```

> 扩展阅读：[AGENT.md §6](../../AGENT.md) 解释了桌面端与 `dsh web` 会话的调试关系（重点：杀掉托管子进程 Web UI 会闪断，但会话数据在磁盘上，不会丢）。
