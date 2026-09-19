# DSH-Exoskeleton 跨平台与生态（Phase 4）设计方案

> 状态：**方案存档，未实施**（2026 基线 main · dsh-desktop v0.9.x）
> 范围：把当前 Windows 专属桌面壳扩展到 macOS / Linux，并推进插件生态运营
> 结论先行：代码层面好做（Windows 专属代码高度集中，抽一层平台适配即可）；发布层面 macOS 签名+公证与 Linux 碎片化是真正的成本

---

## 1. 目标与背景

当前应用为 **Windows 专属**（NSIS 安装版 + 便携版，electron-builder.yml 仅 `win` 目标）。
Phase 4 目标：

1. **跨平台**：macOS / Linux 可编译、可运行、可自动更新
2. **生态**：插件市场、社区文档、更新分发、品牌建设（运营性质）

### 关键判断（代码勘察结论）

- 核心逻辑（config / logger / backup / sessions / plugins / kernel-manager 的 npm 部分 / session-watcher / zstd）全部使用 `node:` 标准库 + `os` + `path.delimiter`，**天生跨平台**，零改动
- Windows 专属代码**高度集中**在 5~6 个文件的特定函数，可整体抽入平台适配层
- 自动更新走 `provider: github`（electron-updater），三平台产物上传同一 GitHub Release 即自动生成 `latest.yml / latest-mac.yml / latest-linux.yml`，**更新逻辑一行不用改**
- 内置 Node 运行时 / 托管内核（npm tarball）分发天然跨平台，只需平台二进制映射

---

## 2. 现状盘点

### 2.1 已天然跨平台（无需改动）

| 模块 | 说明 |
| :--- | :--- |
| config / logger | userData 路径 + 原子写 + 轮转，`node:` API |
| backup / sessions / zstd-worker | 纯 fs + worker 线程 |
| plugins.ts | 转发 `dsh plugin`（pnpm/npm 跨平台），PATH 注入用 `path.delimiter` |
| kernel-manager 主要内容 | npm registry tarball + sha512，跨平台 |
| session-watcher / notification-hub | 与平台无关的事件逻辑 |
| window-manager 大部分 | 窗口几何恢复（`screen`）、WebContentsView、`show()` 前台锁已有 `process.platform === 'win32'` 分支 |
| resolveDshHome | `os.homedir()` + `DSH_HOME` 环境变量，跨平台 |
| 托盘 / 单实例 / IPC | Electron 跨平台 API |

### 2.2 Windows 专属代码分布

| 文件 | 专属点 | 改动方式 |
| :--- | :--- | :--- |
| `src/main/dsh-manager.ts` | `taskkill /pid /T /F`（killTree / killTreeAndWait）；`where dsh.cmd / dsh / node / git`；`npm.cmd prefix -g`；dsh.cmd 内部 `"%dp0%\node_modules\..."` 正则解析 | 抽 `platform/process.ts`、`platform/lookup.ts` |
| `src/main/runtime-manager.ts` | 固定下载 `node-<ver>-win-<arch>.zip`；`tar.exe` → `powershell Expand-Archive` 解压；解压产物 `node-v*-win-*`；`node.exe` | 抽 `platform/runtime.ts`（dist 平台映射 + 解压分支 + 可执行名） |
| `src/main/notify.ts` | Windows toast：toastXml / AUMID / `dsh-exo://` 协议激活 / 通知注册表 | 抽 `platform/notifier.ts`（三平台三套通知体系） |
| `src/main/index.ts` | `app.setAppUserModelId('io.dsh.exoskeleton')`；登录项 `path: process.execPath + ['--hidden']` | 条件包裹 + 平台分支 |
| `src/main/window-manager.ts` | 已基本跨平台；窗口无标题栏（`titleBarStyle:'hidden'` + `titleBarOverlay`），Windows/Linux 由 overlay 提供原生窗口按钮；macOS 需确认识别红绿灯位置与拖拽区共存 | 小改 |
| `src/main/titlebar-overlay.ts` | 叠加层底色同步（`setTitleBarOverlay` 原生仅 `@platform win32,linux`）：Windows/Linux 生效，macOS 用红绿灯无 overlay；`applyTitleBarOverlay` 已 try/catch 静默忽略，无需平台分支 | 无需改 |
| `electron-builder.yml` | 仅 `win: nsis + portable` | 加 `mac` / `linux` 目标 |
| 图标 / CI | `resources/icon.png` 单平台；`.github/workflows/ci.yml` 仅 typecheck 无构建矩阵 | icns 生成脚本 + CI 矩阵 |

> 注：`notify.ts` 未在本次勘察全文读取，实施时先读 `src/main/notify.ts` 再抽离。

---

## 3. 总体思路：平台适配层

新增 `src/main/platform/`，把全部平台差异圈进一个目录，主流程代码只调用抽象接口：

```
src/main/platform/
├── process.ts    # 进程树强杀 / 存活探测
├── lookup.ts     # 可执行文件探测（where ↔ which）、npm/npx shim 名
├── runtime.ts    # Node dist 平台映射 + 解压 + 可执行名
├── notifier.ts   # 通知抽象（win toast / mac Notification / linux 走 Electron Notification=DBus）
└── paths.ts      # userData / dshHome / 工作目录兜底（现状已基本通用，收口即可）
```

**验收门禁（Step 1）**：`npm run typecheck` + `npm test` 全绿，Windows 上行为回归不变（纯重构，零行为变化）。

---

## 4. 实施方案（五步，可独立验收）

### Step 1 — 平台适配层重构（纯重构，先做）

- `platform/process.ts`：win `taskkill /pid /T /F`；posix `spawn(detached:true)` + `kill(-pid, 'SIGKILL')`
- `platform/lookup.ts`：`where` → `which`（注意 PowerShell 里 `which` 是 alias，需绕开）；`npm.cmd` → `npm`
- `platform/runtime.ts`：
  - dist 映射：`win-{x64,arm64}.zip` / `darwin-{x64,arm64}.tar.gz` / `linux-{x64,arm64}.tar.xz`
  - 解压：win `tar.exe` → `Expand-Archive`（现有链）；unix 系统 `tar`（xz 需确认系统支持，必要时换 Node 库）
  - 可执行名：`node.exe` vs `node`
- `platform/notifier.ts`：win toast（现状）/ mac `Notification` + `open-url` 事件 / linux Electron Notification（DBus），协议激活仅 win（`dsh-exo://` 在 mac 需 Info.plist URL scheme 声明，见 Step 2）
- `index.ts`：`setAppUserModelId` 包 `process.platform === 'win32'`；登录项参数平台分支

### Step 2 — macOS（建议优先：用户基数大、Electron 支持最成熟）

- `electron-builder.yml` 加 `mac: dmg + zip`；`hardenedRuntime` + entitlements + notarize 配置（证书走 CI secrets，见 Step 4）
- Info.plist 注册 `dsh-exo://` URL scheme（macOS 冷启动协议走 `open-url` 事件而非 argv —— `index.ts` 协议激活逻辑加分支）
- 标题栏：无标题栏（`titleBarStyle:'hidden'` + `titleBarOverlay`）；macOS 需确认识别红绿灯位置与顶部拖拽区共存（`trafficLightPosition`）
- 通知改 mac 原生；开机自启 `setLoginItemSettings` mac 专用参数
- 图标：`render-icons.cjs` 增加 `icns` 生成（electron-builder mac 需要 icns）

### Step 3 — Linux

- `electron-builder.yml` 加 `linux: AppImage + deb`
- 托盘图标 + libappindicator 依赖说明（AppImage 自带）
- Linux `setLoginItemSettings` 支持有限 → XDG autostart `.desktop` 自写，或降级说明
- Wayland / GTK 标题栏细节；内置 Node linux 二进制

### Step 4 — CI 矩阵 + 签名发布

- `.github/workflows/ci.yml` 加构建矩阵：`windows-latest / macos-latest / ubuntu-latest`
- 三平台产物上传**同一个** GitHub Release（`provider: github` 自动生成多平台 `latest*.yml`，自动更新零改动）
- 签名 secrets：`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
- macOS 公证在 CI mac runner 上执行

### Step 5 — 生态（运营性质，非一次性工作量）

- 插件市场基础设施已有（GitHub topic + npm 双源目录、安装/更新/卸载、推荐列表）→ 扩充目录 + 插件开发文档 + 模板仓库
- `CONTRIBUTING.md`、Issue/PR 模板、下载页（GitHub Pages 已有架构图页可扩展）
- 更新通道继续 GitHub Releases；用户量大后可换自建 generic provider

---

## 5. 工作量估计

| 阶段 | 工作量 | 主要风险 |
| :--- | :--- | :--- |
| Step 1 适配层 | 1 周 | 低（回归测试兜底） |
| Step 2 macOS | 1~2 周 | **签名+公证**是硬门槛，无证书则自动更新不可用 |
| Step 3 Linux | 1~2 周 | tray / Wayland / 发行版碎片化，坑最多 |
| Step 4 CI | 2~3 天 | 无 |
| Step 5 生态 | 持续投入 | 无 |

---

## 6. 风险清单

1. **macOS 签名与公证**：electron-updater 在 mac 上要求代码签名 + 公证，证书缺失时自动更新不可用；每次发版重新公证
2. **内置 Node ABI**：原生模块（node-pty 等）按平台/架构编译，内置 Node 必须选对平台二进制（现状 runtime-manager 是 win 专用 zip 名）
3. **`which` vs `where` 探测差异**：PowerShell 环境 `which` 是 alias，绕选手法要测试
4. **dsh.cmd 解析**：仅 Windows 有意义；unix 直接探测 npm shims（`@deepseek-ai/dsh/lib/bin.js` 由 node 直跑，现路径已优先）
5. **Linux 托盘依赖**：libappindicator 在部分发行版缺失 → 托盘不可见（AppImage 内自带可缓解）
6. **Wayland**：窗口置顶/聚焦行为差异，现有 Windows 前台锁对策不适用
7. **标题栏**：无标题栏 + overlay 在 macOS 下的红绿灯位置与拖拽区共存需确认
8. **发布资产一致性**：沿用 AGENT.md §7-13 的经验（release commit 完整性、资产核对、草稿清理），三平台后核对更多资产

---

## 7. 已确认的事实与参考

- 当前基线 `main`（v0.9.x），发布走 `main` + `v0.x.y` 标签，**只升 patch**
- `electron-builder.yml` 现状：`appId: io.dsh.exoskeleton`、`provider: github`、win 仅 nsis(x64) + portable(x64)
- 自动更新：打包版 electron-updater 静默下载 + 通知一键重启；便携版 GitHub API 引导手动下载（`src/main/updater.ts`）
- 内置 Node：`DSH_NODE_DIST` 可换镜像；sha256 完整性校验已有（R-11）