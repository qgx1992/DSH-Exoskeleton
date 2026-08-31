# 03 · 首次运行

> 目标：克隆仓库 → 启动桌面客户端 → 走完验证清单。
> 前置：[02-setup.md](02-setup.md) 环境已配好。

## 1. 克隆仓库

```powershell
git clone https://github.com/qgx1992/DSH-Exoskeleton.git
cd DSH-Exoskeleton
```

## 2. 安装依赖并生成图标

```powershell
npm install       # 首次较慢，耐心等待
npm run gen:icon  # 首次需要：生成应用图标（scripts/build-*.mjs + render-icons.cjs）
```

## 3. 启动开发模式

```powershell
npm run dev
```

启动后会发生这些事（对照着看，能帮你建立"发生了什么"的心智模型）：

1. electron-vite 编译主进程 / preload / 渲染层，弹出**无边框窗口**（黑金标题栏）；
2. 主进程（`src/main/index.ts`）拿单实例锁 → 读配置 → `dsh-manager` 启动 `dsh web --port 0`（自动分配端口）；
3. 首次启动时：检测 `~/.dsh/.credentials.yaml`，没 API Key 就弹出**首次启动向导**；同时自动安装默认内核（`0.1.2-alpha.1`）；
4. 健康检查通过后，`window-manager` 用 WebContentsView 把 **DSH Web UI** 嵌进主窗口。

> ⚠️ `npm run dev` 对渲染层有 HMR（改界面即时生效），但**主进程 / preload 改动需要重启**（Ctrl+C 后重新 `npm run dev`）。

## 4. 验证清单（首次跑通的"考试"）

| # | 检查项 | 预期 | 不过怎么办 |
| :--- | :--- | :--- | :--- |
| 1 | 窗口出现 | 无边框窗口 + 黑金标题栏 | 看终端报错；查日志（见 §6） |
| 2 | 标题栏状态点 | **青** = 服务运行中 | 灰=启动中稍等；红=异常，查日志 |
| 3 | 首次启动向导 | 未配 API Key 时弹出，引导填写 | 可稍后在仪表盘「设置」页补 |
| 4 | DSH Web UI 加载 | 主窗口内出现 DSH 聊天界面 | 服务未就绪，看状态点 |
| 5 | 仪表盘各 Tab 可切换 | 状态/设置/内核/档案/插件/备份/日志/更新 | 渲染报错看终端 |
| 6 | 托盘图标 | 关闭窗口后缩到托盘（默认行为），右键菜单可用 | 设置里可关 `minimizeToTray` |
| 7 | 单实例 | 再次双击 exe 唤出已有窗口，不开第二个 | — |
| 8 | 日志有内容 | `%APPDATA%\DSH-Exoskeleton\dsh-desktop.log` 非空 | 见 §6 |

## 5. 常用命令速查

| 命令 | 作用 | 备注 |
| :--- | :--- | :--- |
| `npm run dev` | 开发模式（HMR） | 主进程改动需重启 |
| `npm run typecheck` | TypeScript 双工程类型检查 | **任何改动收尾前必跑**（硬门禁） |
| `npm test` | 主进程模块冒烟测试（`scripts/test-*.cjs`） | 涉及行为/测试范围的改动要跑 |
| `npm run build` | 构建产物到 `out/` | |
| `npm run dist` | 构建 + electron-builder 打包 | NSIS 安装版 + 便携版 + win-unpacked |
| `npm run release:notes -- vX.Y.Z --out ...` | 生成中文更新日志 | 发布流程用，见 AGENT.md §0 |
| `npm run gen:icon` | 重新生成图标 | 改图标资源后跑 |

## 6. 首次运行常见问题

| 现象 | 原因 / 处理 |
| :--- | :--- |
| 端口冲突 | 桌面端默认 `--port 0` 自动分配端口，一般不会冲突；可在仪表盘「设置」固定端口 |
| 内核安装失败/很慢 | 国内网络问题：切 npmmirror 镜像；`DSH_NODE_DIST` 换 nodejs.org 镜像；失败会在下次启动重试 |
| 状态点一直红 | 打开 `%APPDATA%\DSH-Exoskeleton\dsh-desktop.log`，搜 `[dsh stdout]` / `[dsh exec]` 看子进程输出 |
| 找不到 dsh | 确认 §6 定位顺序：`DSH_EXECUTABLE` → 全局 `@deepseek-ai/dsh` → PATH 的 `dsh.cmd` |
| 完全卡死 | 托盘右键退出 → 任务管理器结束所有 `DSH-Exoskeleton` / `electron` 进程 → 重启 `npm run dev` |

## 7. 分支与版本（提前知道，少踩坑）

- 发布基线是 `main` 分支（当前 v0.8.x），功能开发在特性分支；
- **版本只升 patch**（0.8.1 → 0.8.2 → …），用 `npm version patch`，禁止跳 minor/major（详见 AGENT.md §0）；
- 提交前跑 `npm run typecheck`；提交后**不自动 push**，等确认。

## 8. 下一步

- 环境已通 → 读 [04-code-map.md](04-code-map.md)（🚧 规划中，先看 [AGENT.md §3](../../AGENT.md) 目录结构）
- 想改第一个功能 → [05-first-change.md](05-first-change.md)（🚧 规划中）
- 想了解规则全貌 → [AGENT.md](../../AGENT.md)
