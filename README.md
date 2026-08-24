# DeepSeek Harness 桌面客户端（DSH-Exoskeleton）

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
| 数据复用 | DSH_HOME 环境变量优先，否则 `%USERPROFILE%\.dsh` |
| 安全隔离 | 仅监听 `127.0.0.1`、渲染进程沙箱、`contextIsolation`、禁用 Node 集成 |
| 自动更新（P2 占位） | 检查 DeepSeek Harness 官方最新 Release，引导下载 |

## 技术栈

Electron + TypeScript + React + Tailwind CSS + Vite（electron-vite）+ electron-builder

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
dist/DeepSeek-Harness-Setup-x64-0.1.0.exe    # NSIS 安装器
dist/DeepSeek-Harness-Portable-0.1.0.exe     # 单文件便携版
dist/win-unpacked/                           # 免安装绿色版文件夹
```

## DSH 可执行文件解析

主进程按以下顺序定位 `dsh`：

1. `DSH_EXECUTABLE` 环境变量（显式指定）
2. npm/pnpm 全局安装的 `@deepseek-ai/dsh`（`lib/bin.js` 由 Node 直接运行，不依赖路径）
3. PATH 中的 `dsh.cmd`

> 「零门槛」目标：后续版本将支持打包内置 DSH 内核，免除用户手动安装 dsh。

## 配置项

存储于 `%APPDATA%\DeepSeek Harness\config.json`：

| 配置 | 用途 | 默认 |
| :--- | :--- | :--- |
| `port` | Web 服务端口 | `0`（自动分配） |
| `workspace` | Agent 工作区（预留） | 空 |
| `autoLaunch` | 开机自启 | `false` |
| `apiKey` | DeepSeek API Key（系统级加密，P1 引导） | 空 |
| `dshHome` | DSH Home 覆盖 | 空（官方规则） |
| `autoStartService` | 启动时自动运行服务 | `true` |
| `minimizeToTray` | 关闭窗口隐藏到托盘 | `true` |

## 日志

`%APPDATA%\DeepSeek Harness\dsh-desktop.log`（2MB 轮转），仪表盘提供实时查看，托盘菜单可打开日志目录。

## 路线图

- [x] Phase 1 — MVP：脚手架 / 原生窗口 / 托盘 / 单实例 / DSH 进程管理 / 端口自动分配
- [x] Phase 2 大部分：API Key 首次启动向导 / 数据复用 / 安全隔离 / 日志查看 / 原生通知 / 开机自启
- [ ] Phase 2 剩余：工作区目录集成的完整体验
- [ ] Phase 3：自动更新落地 / 插件管理 / 备份回滚 / 三种分发形态
- [ ] Phase 4：多 Profile / 跨平台 / 社区生态

## 参考项目

- [dsh-clean-desktop-shell](https://github.com/Icather/dsh-clean-desktop-shell)
- [DSHDesktop (CCMu04)](https://github.com/CCMu04/DSHDesktop)
- [dsh-desktop (SnowCrescenter)](https://github.com/SnowCrescenter-tech/dsh-desktop)
- [dsh-desktop (kevenxz)](https://github.com/kevenxz/dsh-desktop)
- [dsh-desktop (csyyywy)](https://github.com/csyyywy/dsh-desktop)
- [deepseek-harness-desktop (Tauri)](https://github.com/dsh-tauri-desk/deepseek-harness-desktop)
- [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)
- [DeepSeek Harness 官方](https://github.com/deepseek-ai/deepseek-harness)