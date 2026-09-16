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
| **窗口管理** | 无标题栏窗口（`titleBarStyle:'hidden'` + `titleBarOverlay`，右上角原生窗口按钮）、单实例 | SnowCrescenter[reference:23] |
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

**功能**：无标题栏窗口 + 系统原生窗口按钮叠加（内容从 y=0 起）。

**实现要点**：
- `titleBarStyle: 'hidden'` + `titleBarOverlay`：内容从 y=0 铺满，右上角为**系统原生**最小化/最大化/关闭（叠加在内容之上、不占布局），无需自绘也不占内容空间
- `Menu.setApplicationMenu(null)` 移除 Electron 默认应用菜单（File / Edit / View / Window / Help）。实测：不清理时带 frame 的窗口会把它画成菜单栏（窗口高-内容高 = 39px）
- 顶部那一行直接是 **DSH 自己的侧边栏品牌行**（鲸鱼 logo + deepseek HARNESS），壳不重复绘制品牌
- 窗口拖动：三块拖拽区，均在同一次 `insertCSS` / 同批注入里下发（§4.1.2.3）
  1. DSH 侧边栏品牌行（logo 行）——行内按钮回设 `no-drag`（logo 本身是「新建会话」按钮）
  2. 中间主体顶部**会话态**：`header` 设 `drag`，行内按钮/svg/img 回设 `no-drag`
  3. 中间主体顶部**空态**：固定定位透明拖拽条 `#dsh-exo-drag-strip`（空态没有有高度的 header）
- 窗口几何（大小/位置/最大化）仍由壳保存与恢复（`configStore.windowBounds`）
- **管理面板入口在系统托盘菜单**（「管理面板…」，§4.1.3），面板内可随时「回到 Web UI」
- **网页版 DeepSeek 入口注入在 DSH Web UI 自己的左侧边栏**（底部「设置」行上方），详见 §4.1.5
- **叠加层底色跟随当前表面**：`titleBarOverlay.color` 是窗口级的，而内容区依次承载底色不同的表面（壳管理面板 `#060B12`、DSH 顶栏 暗 `#151517` / 亮 `#FFFFFF`、网页版站点自定）。固定一个色必然与其中若干表面错位（旧实现硬编码 `#0b0f17`，实测在 DSH 顶栏上留下 ΔRGB=10 的横向色缝），故由 `main/titlebar-overlay.ts` 探针实测当前顶栏色后 `setTitleBarOverlay` 同步；暗/亮主题切换经 `body[data-ds-dark-theme]` 的 MutationObserver 回壳跟随（详见 §4.1.2.1）
- 关闭按钮 = 隐藏到托盘（`close` 事件 `preventDefault`），不退出进程[reference:32]

**Electron 配置**：
```javascript
// main/window-manager.ts
const win = new BrowserWindow({
  width: 1200,
  height: 800,
  // 无标题栏：内容从 y=0 起，右上角叠系统原生窗口按钮（不占布局）
  titleBarStyle: 'hidden',
  // 起步色 = 壳画布色（与 renderer --color-canvas 同值）；随后由 syncTitleBarOverlay 同步
  titleBarOverlay: {
    color: SHELL_CANVAS_COLOR,            // #060B12
    symbolColor: pickSymbolColor(SHELL_CANVAS_COLOR), // 按底色对比度自动取深/浅
    height: 36
  },
  title: 'DSH-Exoskeleton',
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    sandbox: true,           // 安全隔离[reference:33]
    nodeIntegration: false,  // 禁止 Node.js 集成[reference:34]
    contextIsolation: true,
  }
});
```

#### 4.1.2.1 叠加层底色同步（titlebar-overlay）

**问题**：`titleBarOverlay.color` 是**窗口级**单值，但同一个窗口的内容区会依次换成底色不同的表面。旧实现硬编码 `#0b0f17`，实测（桌面级截屏取样）在 DSH 顶栏 `#151517` 上形成横贯色缝，边界恰好离右边缘 137px——正是三个按钮底下那块矩形。

**三个表面与色值**：

| 表面 | 暗色 | 亮色 | 取值方式 |
| --- | --- | --- | --- |
| 壳管理面板 | `#060B12` | （固定暗色） | 常量 `SHELL_CANVAS_COLOR`，与 `--color-canvas` 同值 |
| DSH Web UI 顶栏 | `#151517` | `#FFFFFF` | 页面探针实测（`--dsw-alias-bg-base`） |
| 官方网页版 | 站点自定 | 站点自定 | 同探针实测，失败回退当前 DSH 主题色 |

**取色策略**（`buildTopColorProbeScript`）：在 overlay 带内、靠右边缘取 4 个横向采样点（即按钮压住的区域），每点**沿祖先链向上找第一个不透明背景**（穿透 `rgba(0,0,0,0)` 的中间层），再取众数抗零星功能按钮干扰；元素层全透明时回退官方令牌 `--dsw-alias-bg-base` → `body` 背景 → 主题兜底常量。

**笔画色**：`pickSymbolColor` 按 WCAG 相对亮度在 `#f9fafb`（DSH 暗色文字色）与 `#0f1115`（DSH 亮色文字色）间取对比度更高者，暗/亮实测 17.45 / 18.90，不会出现「白底白按钮」。

**同步时机**：窗口创建（壳画布色）→ DSH 视图挂载（先落主题兜底值再异步纠正）→ 网页版/管理面板显隐 → DSH 主题切换。

**测试**：
- 单测 `scripts/test/test-titlebar-overlay.cjs`（30 项，`npm test`）：颜色归一化/半透明拒绝、笔画对比度、探针穿透半透明层、令牌回退、主题观察回环、常量一致性
- 端到端 `scripts/probe/verify-titlebar-overlay.cjs`（9 项）：**桌面级 GDI 截屏**比对按钮簇与其下方页面底色，含「换回旧值必须变色」的对照实验
- ⚠️ 方法学陷阱：**不能用 `capturePage` 验证此项**——它只抓 WebContents 自身像素，原生 overlay 由系统画在其上、不进 web 图层，比对「带内 vs 带外」等于拿页面比自己，必然 Δ=0 形成假通过

#### 4.1.2.2 会话头部让位（避免被原生按钮遮挡）

**问题**（实测 `scripts/probe/probe-overlap-widths.cjs`）：原生按钮簇占右上角 `x ∈ [W-138, W], y ∈ [0, 36]`；DSH 会话头部 `<header>` 在 `y = 0..86`、`titleRow` 在 `y = 10..42`，于是**每个窗口宽度下都重叠 110×26 = 2860px²**，`headerUtilities`（124×28）约 62%、`headerCorner`（28×28）约 86% 被压在最小化/最大化按钮之下。

**为什么壳必须出手**：`env(titlebar-area-*)` 实测在本应用的 WebContentsView 子视图内全为 `-1px`——Electron 没有把 WCO 变量下发到子视图，DSH 自己无从避让。

**修法**：`header { padding-top: 36px }`（随 overlay 高度参数化），整行下移。

| 决策 | 取值 | 依据 |
| --- | --- | --- |
| 锚点 | `header`（语义标签） | CSS module 类名是 hash（`wSkVaW_header`）不可依赖；实测 `<header>` 全页只命中 1 个且正是目标 |
| 改 padding 而非 margin/位移 | `padding-top` | header 是 grid 行，padding 撑高该行后后续内容（选项卡、会话视图）自动下推，不叠层、不留白 |
| 附带 `height:auto` + `min-height` | 原 86px + overlay 高 | 防 `box-sizing:border-box` 下固定高度被压缩、以及折叠时塌陷 |
| 同批注入 | 与拖拽区 CSS 合并 | 一次 `insertCSS` 下发，避免两次注入的先后竞态 |

**验证** `scripts/probe/verify-header-offset.cjs`（22 项）：逐宽度（1440/1280/1200）断言零重叠、header 只命中 1 个、标题行 `top ≥ 36`、页面未被撑出滚动条、选项卡顺序正常；并含两项防自欺：
- **非空过门禁**：先轮询确认会话头真的渲染（`header` 高度 > 0 且 `titleRow` 存在）再判重叠——空态下「无重叠」是 vacuous pass，第一版脚本就因此假通过
- **基线对照**：修复前必须实测到重叠（432px²），否则用例无鉴别力

#### 4.1.2.3 顶部拖拽区（窗口拖动）

**问题**：无系统标题栏后，窗口只能靠页面里的拖拽区拖。而 `-webkit-app-region` **不继承**（初始值 `none`），必须逐块声明。旧实现只声明了 DSH 侧边栏的 `logoRow` 一处，于是**中间主体顶部拖不动**（用户反馈"只有左侧边栏顶部可以拖动"）。

**实测取证**（`scripts/probe/probe-drag-region-dom.cjs`，y=18 横向扫描、沿祖先链解析 `app-region`）：

| x | 命中元素 | 解析 region |
| --- | --- | --- |
| 60–260 | `div.hHd-Xa_logoRow` | `drag` ✅ |
| 300–1380 | `header.wSkVaW_header` / `div.wSkVaW_scrollBody` | `none` ❌ |

三个坑（缺一不可）：
1. **不继承**：中间列从未被声明，就是普通网页内容；
2. **会话态 header 是空内边距**：`padding-top:36px`（§4.1.2.2 的让位规则）使 `y<36` 恰好是 header 的空白区——好消息，在这里设 drag 不会压住任何内容；
3. **空态根本没有有高度的 header**：DSH 不渲染会话头（实测只有 1 个 0 高度 `header`），该位置命中的是整列高的 `div.wSkVaW_scrollBody`——它同时承载聊天区，**不能**设 drag（会让整个消息区无法滚轮/选中），故空态只能另想办法。

**修法**（两种态分开处理）：

| 态 | 手段 | 依据 |
| --- | --- | --- |
| 会话态 | CSS：`header { -webkit-app-region: drag }` + 行内 `button/a/input/select/textarea/svg/img/[role]` 回设 `no-drag` | `y<36` 是空内边距，无内容可压；实测 15 个 header 内可交互元素全部解析为 `no-drag` |
| 空态 | 脚本插入固定定位透明条 `#dsh-exo-drag-strip`（`y<36`，`left`=侧边栏宽，`right`=138px） | 实测空态该带内可交互元素为 **0 个**，纯空白，可安全整条设 drag |

**空态拖拽条的三条约束**（都有实测依据）：
- **只在空态插**：会话态 header 自己已是拖拽区，此时留着拖拽条会压住标题行的面包屑等按钮（实测覆盖 3 个 `button`）→ 脚本内 `hasHeader()`（存在高度 > 0 的 `header`）为真即 `remove()`；
- **左边界跟随侧边栏**：侧边栏可折叠（实测 280px ↔ 56px），写死会要么盖住侧边栏按钮、要么在收起后留一条拖不动的缝。每次 sync 现测 `[class*="sidebarCol"]` 宽度；
- **右边界让开原生按钮簇**：Windows 下按钮簇占 `x ∈ [W-138, W]` 且画在内容之上，铺过去也没用（`WINDOW_CONTROLS_CLUSTER_WIDTH = 138`）。

**自愈与跟随**：
- 拖拽条由 `buildTopDragStripScript` 创建（幂等：固定 id + `__dshExoDragStripInstalled`），React 重渲染清掉外部节点后由**内容变更观察器**节流补插（与侧边栏入口同策略）；
- 侧边栏折叠**只改布局宽度、不改 class 也不增删节点**，内容变更观察器完全看不到 → 另接 `ResizeObserver(侧边栏列)` + `window.resize`；列元素要等 React 首次渲染才存在，故加短轮询（500ms × 40 次，拿到即停）；
- 壳侧 `windowManager.syncDragStrip()` 在窗口 `resize` 时再显式推一次（WebContentsView 场景页面未必收到 resize）。

**验证** `scripts/probe/verify-drag-region.cjs`（22 项）：空态/会话态/折叠后三种情形下断言带内采样点全部 `drag`、带内零被盖可交互元素、会话态 header 内可交互元素全部 `no-drag`（**防误拖：按钮必须可点**）、拖拽条左右边界贴合、页面未出滚动条；并含三项防自欺：空态必须确实没有有高度的 header、会话态 header 必须已渲染（非空过）、折叠必须真的改变了列宽。

#### 4.1.3 系统托盘

**功能**：程序常驻后台，单击唤回窗口，右键菜单齐全[reference:35]。

**右键菜单**：
- 打开主界面
- 管理面板…（打开并定位到总览页）
- 启动/停止 DSH 服务
- 开机自启（复选）[reference:36]
- 打开日志目录[reference:37]
- 检查更新
- 关于
- 退出

**实现要点**：
- 关闭窗口时隐藏而非退出（`win.hide()`）[reference:38]
- 托盘单击唤回窗口（`win.show()`）

#### 4.1.5 网页版 DeepSeek（DSH 左侧边栏入口）

**功能**：DSH Web UI 左侧边栏底部提供一个「网页版 DeepSeek」入口，点击后在侧边栏右侧嵌入官方 chat.deepseek.com，再点收起。

**实现要点**（`src/main/web-sidebar-entry.ts`）：
- **入口用 DOM 注入**：往官方插槽渲染出的锚点 `[data-slot="sidebar.footer.action"]` 插一个按钮。
  该标记**不带 hash、跨版本稳定**；CSS module 类名是 hash（实测 `pI_x6G_sidebarCol`）不可依赖。
  锚点 `display: contents`，按钮自然排进侧边栏底部那一列（与第三方「今日¥」同列，「设置」行上方）。
- **为何不用官方插槽注册**：`sidebar.*` 插槽是 cordis 客户端插件的注册面，需独立插件包
  （本仓 `plugins/` 已 gitignore，插件源码在各自仓库），而壳要开箱即用。
- **点击链路**：注入按钮 → `window.__dshExo.send('webpanel:toggle')`（既有 dsh-view 桥，R-27 白名单不扩大）
  → 主进程 `ipc-message` 监听 → `windowManager.toggleWebPanel()`。
- **鲁棒性**：幂等（节点 id + 安装标记判重）、MutationObserver 节流自愈（React 重渲染清掉后补插）、
  选中态由壳 `executeJavaScript` 回写。
- **承载方式**：仍用独立 `WebContentsView`（登录态存 `persist:deepseek-web`，重启保留）。
  **为何不用 iframe**：官方响应头实测 `Content-Security-Policy: frame-ancestors none`，iframe 会被拦截；
  独立视图是顶级浏览上下文，不受该 CSP 限制。
- **侧边栏宽度**：实测（约 280px）后把网页版视图定位到它右侧；截图/实测脚本见
  `scripts/probe/verify-web-sidebar-entry.cjs`（6 项全通过）与 `scripts/probe/verify-shell-top.cjs`（5 项全通过）。

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
- 通知标题为「项目名 · DSH 对话完成」（无项目名时仅基础标题），正文为会话标题 + 轮次（第 N 轮），第二行为「本次：本轮提问」
  - v0.9.5 调整：项目名原在正文开头（`项目「X」· 标题`），与会话标题（本身就是用户首句提问）叠在一起很快被截断；现移至标题行，正文腾出可见长度
  - 为何要「本次：」：**会话名固定取自第一句提问**（DSH 的 `session/title`，无此事件时回落首条用户消息），所以多轮会话的每条通知会长得一模一样——看不出刚完成的是哪一轮。第二行补上本轮真实提问才能区分。
  - 「本轮提问」的取法（`zstd-worker.cjs`）：`user/message` 事件**不带 turn 编号**，只能按顺序关联——每遇 `turn/start` 切换当前轮，该轮内**第一条非注入**的 user 消息即本轮提问。必须过滤系统注入的伪用户消息（`Current runtime context` / `<system-reminder>` / `[genui-action]` / `[model changed` / `[Suggestion mode` / `The user …` / `background job`），否则会把运行时上下文当成人问的话。实测 65 个真实会话 / 205 个已完成轮次，命中率 98%（未命中则回落为只显示会话标题，不拼空的「本次：」）。
- watcher 启动前已存在的旧会话（基线）不误报

**会话日志的定位（关键，勿拼字面量）**：日志文件名随内核 Session format 代数变化，
**不是固定的 `session.jsonl.zstd`**——格式每迁移一版，内核就新写一个 `session.vN.jsonl`（旧文件保留不删）：

| 世代 | 文件名 |
|------|--------|
| v0（原始） | `session.jsonl.zstd` |
| v3（内核 0.1.5+） | `session.v3.jsonl.zstd` |

因此 `session-watcher.ts` 与 `sessions.ts` 必须走 `shared/session-jsonl.ts` 的
`resolveSessionLog(sessionDir)`（镜像内核 `dsh-session-format` 规则，**取最高代数**）：
- v0 与 v3 并存（格式迁移现场）→ 必须读 v3，读 v0 拿到的是迁移前的陈旧内容
- 日志换世代时 watcher 需**重建基线**（新旧文件偏移无对应关系，否则错位解析出一批误报）
- 明文 `.jsonl`（非 zstd）本壳无法解压 → 跳过并告警，不每轮空转

> 历史故障：内核 0.1.5 升 v3 后壳侧仍按旧名 `stat`，导致会话完成/询问卡通知**全部静默丢失**，
> 且面板只看得见未升级的旧会话。踩坑与排查方法见 AGENT.md §7 第 15 条。

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
- 默认启用清单 = `RECOMMENDED_PLUGINS.filter(p => p.defaultEnabled)`；当前清单为空（`dsh-ui-tools` 曾默认启用，v0.8.0 起改为普通推荐条目，用户按需手动安装）。

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
| 原生窗口 | 无标题栏（titleBarOverlay，右上角原生窗口按钮）+ 窗口几何记忆 |
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

### 内核管理（阶段 A/B/C/D，已落地）

| 阶段 | 内容 | 落地 |
| :--- | :--- | :--- |
| A | KernelManager：npm 下载/校验/安装到 userData/kernels/、默认路由、卸载 | v0.3.0 |
| B | 内置 Node 运行时（runtime-manager.ts：一键下载/解压/自检，resolveNode 优先）；内核更新检测（dist-tags latest/rc）+ 一键升级；进度推送 | v0.6.0 |
| C | 多 Profile 档案（profiles.ts + 档案面板）：档案绑定内核版本、切换即换内核；卸载引用保护；磁盘配额（kernelsQuotaMB） | v0.6.0 |
| D | 首启默认内核预置（kernel-provision.ts）：全新安装首次启动自动安装 `DEFAULT_KERNEL_VERSION`（src/shared/kernel-defaults.ts，当前 0.1.2-alpha.1）并设为默认；无 Node 先自动下载内置运行时；老配置迁移跳过、失败下次重试 | v0.8.0 |

**验收**：全新机器仅装应用 → 下载内置 Node 运行时 + 托管内核 → 打开 DSH Web UI；不同档案稳定运行不同内核版本；全新安装首启自动装好默认内核（老用户升级零打扰）。

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

### 8.3 AI 协作与文档职责

仓库内 AI 协作规则以根目录 **AGENT.md** 为唯一权威事实源（含工作约定、关键不变量 R-N、插件系统说明、已知坑等）；本文档（DEV_DOC.md）与 `docs/KERNEL-MANAGER-DESIGN.md` 提供设计与实现细节，README 面向用户导览。

- **冲突顺序**：AGENT.md → 设计文档 → README；工具/平台适配差异只允许补充降级与回退说明，不得改写 AGENT.md 的项目级规则。
- **分工**：AGENT.md 管「Agent 怎么干活」（命令、完成门禁、安全红线、踩坑记录）；DEV_DOC.md 管「系统怎么设计」（架构、模块、API）。
- **维护**：AGENT.md 是活文档，实际踩到新坑应优先沉淀到其 §7；修改 AGENT.md 前先征求用户确认。
- **不推送**：AGENT.md 在 `.gitignore` 中，仅本地协作使用，不进版本库。


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
