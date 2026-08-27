# DeepSeek Harness 桌面客户端（DSH-Exoskeleton）

[中文](README.md) | [English](README.en.md)

> 基于社区 7 个 DSH 桌面端项目调研后的统一开发方案（[开发文档](DEV_DOC.md)）。

轻量、纯净、功能完整的 DSH 桌面外壳：把官方 `dsh web` 封装为**双击即用**的 Windows 桌面程序。
遵循「壳核分离」原则——**不改动 DSH 内核**，官方升级无缝跟随；默认**共用 `~/.dsh`**，已有配置零迁移。

## 功能特性

| 模块 | 说明 |
| :--- | :--- |
| DSH 子进程管理 | 启动/停止/重启 `dsh web`，`--port 0` 自动分配端口，健康检查，崩溃自动重启 |
| 原生窗口 | 无边框窗口 + 自绘标题栏 + 实时状态点（青=运行 / 灰=启动 / 红=异常） |
| 系统托盘 | 单击唤回，右键菜单（打开/启动停止服务/开机自启/日志/更新/关于/退出） |
| 单实例 | 重复双击唤出已有窗口 |
| 仪表盘 | 状态 / 设置 / 日志 / 更新 统一管理面板 |
| 首次启动引导 | 检测 `~/.dsh/.credentials.yaml`，未配置 API Key 时弹出向导，Key 写入本地凭据文件 |
| 原生通知 | 服务就绪 / 异常 / 崩溃重启 时 Windows 通知（可开关） |
| 备份与回滚 | 手动存档 + 自动快照（插件安装/卸载、恢复前）+ 一键回退，快照存于 userData\backups |
| 插件管理 | GitHub topic dsh-plugin + npm 双来源目录，一键安装/卸载（复用 dsh plugin），冲突预检 + 操作前自动备份 |
| 自动更新 | NSIS 安装版 electron-updater 静默下载 → 通知 → 一键重启安装；便携版引导手动下载 |
| 内核管理（阶段 A/B/C） | DSH 多版本共存：安装/默认路由/卸载 + 内置 Node 运行时（零门槛）+ 内核更新检测与一键升级 + 多 Profile 内核绑定 + 磁盘配额 |
| 数据复用 | DSH_HOME 环境变量优先，否则 `%USERPROFILE%\.dsh` |
| 安全隔离 | 仅监听 `127.0.0.1`、渲染进程沙箱、`contextIsolation`、禁用 Node 集成 |

## 技术栈

Electron + TypeScript + React + Tailwind CSS + Vite（electron-vite）+ electron-builder

## 架构总览

![DSH-Exoskeleton 架构](docs/dsh-architecture-preview.png)

> 可交互动画版：[查看架构图（GitHub Pages）](https://qgx1992.github.io/DSH-Exoskeleton/docs/dsh-architecture.html)
> 未启用 Pages 时可用第三方预览：[htmlpreview](https://htmlpreview.github.io/?https://github.com/qgx1992/DSH-Exoskeleton/blob/main/docs/dsh-architecture.html)

## 目录结构

```
├── src/
│   ├── main/          # Electron 主进程
│   │   ├── index.ts           # 入口：窗口/生命周期/单实例
│   │   ├── window-manager.ts  # 无边框窗口 + WebContentsView 承载 DSH Web UI
│   │   ├── dsh-manager.ts     # DSH 子进程管理（启动/停止/健康检查/崩溃重启）
│   │   ├── tray.ts            # 系统托盘
│   │   ├── updater.ts         # 更新检查
│   │   ├── ipc-handlers.ts    # IPC 通信
│   │   ├── config.ts          # 配置管理（userData/config.json）
│   │   └── logger.ts          # 文件日志（轮转）
│   ├── preload/       # contextBridge 类型化桥接
│   └── renderer/      # 外壳 UI（标题栏 + 仪表盘）
│       └── components/panels/ # 状态/设置/日志/更新
├── shared/            # 主/渲染进程共享类型
├── resources/         # 图标
├── scripts/           # 图标生成等脚本
├── electron-builder.yml
└── electron.vite.config.ts
```

## 开发

```bash
# 安装依赖
npm install

# 生成图标（首次）
npm run gen:icon

# 开发模式（HMR）
npm run dev

# 类型检查
npm run typecheck

# 构建
npm run build

# 打包（NSIS 安装包 + 便携版）
npm run dist
```

## 打包产物

```
dist/DSH-Exoskeleton-Setup-0.6.3.exe          # NSIS 安装器
dist/DSH-Exoskeleton-Portable-0.6.3.exe       # 单文件便携版
dist/win-unpacked/                            # 免安装绿色版文件夹
```

## DSH 可执行文件解析

主进程按以下顺序定位 `dsh`：

1. `DSH_EXECUTABLE` 环境变量（显式指定）
2. npm/pnpm 全局安装的 `@deepseek-ai/dsh`（`lib/bin.js` 由 Node 直接运行，不依赖路径）
3. PATH 中的 `dsh.cmd`

> 「零门槛」目标：后续版本将支持打包内置 DSH 内核，免除用户手动安装 dsh。

## 配置项

存储于 `%APPDATA%\DSH-Exoskeleton\config.json`：

| 配置 | 用途 | 默认 |
| :--- | :--- | :--- |
| `port` | Web 服务端口 | `0`（自动分配） |
| `workspace` | Agent 工作区（预留） | 空 |
| `autoLaunch` | 开机自启 | `false` |
| `apiKey` | DeepSeek API Key（系统级加密，P1 引导） | 空 |
| `dshHome` | DSH Home 覆盖 | 空（官方规则） |
| `activeProfileId` | 激活的配置档案 | `default` |
| `kernelsQuotaMB` | 内核仓库磁盘配额（MB，0=不限） | `1024` |
| `autoStartService` | 启动时自动运行服务 | `true` |
| `minimizeToTray` | 关闭窗口隐藏到托盘 | `true` |

## 日志

`%APPDATA%\DSH-Exoskeleton\dsh-desktop.log`（2MB 轮转），仪表盘提供实时查看，托盘菜单可打开日志目录。

## 路线图

- [x] Phase 1 — MVP：脚手架 / 原生窗口 / 托盘 / 单实例 / DSH 进程管理 / 端口自动分配
- [x] Phase 2 — 体验完善：API Key 首次启动向导 / 数据复用 / 安全隔离 / 日志查看 / 原生通知 / 开机自启
- [x] Phase 3 大部分：自动更新（electron-updater 静默下载+一键重启）/ 仪表盘（状态/设置/内核/插件/备份/日志/更新）/
       插件管理器（双来源目录+冲突预检+自动备份）/ 备份与回滚 / 三种分发形态
- [x] 内核管理阶段 A/B/C：托管安装/默认路由/卸载；内置 Node 运行时（真零门槛）；内核更新检测 + 一键升级；
      多 Profile 与内核版本绑定（档案面板）；磁盘配额与卸载引用保护
- [ ] Phase 4：跨平台 / 社区生态

## 内核管理（阶段 B/C 已落地）

- **内置 Node 运行时**：内核面板一键下载（~30MB，nodejs.org，可用 `DSH_NODE_DIST` 换 npmmirror 镜像），之后无需系统 Node（真零门槛）
- 安装走 npm registry（可切 npmmirror 镜像加速国内网络，见 `docs/KERNEL-MANAGER-DESIGN.md`）
- 依赖树较大（单内核 ~50MB+），首次安装耗时受网络影响；内核仓库有磁盘配额保护（`kernelsQuotaMB`，默认 1GB）
- **多 Profile 档案**：每个档案可绑定不同内核版本，切换档案即切换内核（服务自动重启）

## 参考项目

- [dsh-clean-desktop-shell](https://github.com/Icather/dsh-clean-desktop-shell)
- [DSHDesktop (CCMu04)](https://github.com/CCMu04/DSHDesktop)
- [dsh-desktop (SnowCrescenter)](https://github.com/SnowCrescenter-tech/dsh-desktop)
- [dsh-desktop (kevenxz)](https://github.com/kevenxz/dsh-desktop)
- [dsh-desktop (csyyywy)](https://github.com/csyyywy/dsh-desktop)
- [deepseek-harness-desktop (Tauri)](https://github.com/dsh-tauri-desk/deepseek-harness-desktop)
- [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)
- [DeepSeek Harness 官方](https://github.com/deepseek-ai/deepseek-harness)