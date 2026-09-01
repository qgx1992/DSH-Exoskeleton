# DSH-Exoskeleton 通知功能插件化方案（设计文档）

> 状态：**待评审（未实现）** · 对应问题：通知不弹/漏报、点击跳错会话、每轮对话太吵
> 对应目标：开发文档 §4.2.3「原生通知」升级为「可插拔通知显示层」；延续「壳核分离 + 插件化」路线
> 关联代码：`src/main/notify.ts` / `session-watcher.ts` / `index.ts` / `updater.ts` / `window-manager.ts`、`src/shared/recommended-plugins.ts`

---

## 1. 目标与背景

### 1.1 现状

当前所有通知都走 `src/main/notify.ts`（Electron **原生** `Notification`，不支持时降级托盘气泡），共 3 个来源：

| 来源 | 触发 | 代码 |
| :--- | :--- | :--- |
| **对话完成** | 主进程轮询 `~/.dsh/sessions/*/session-*/session.jsonl.zstd`，解析到非 interrupted 的 `turn/end` 即通知（按轮去重），点击 → 唤起窗口 + `activateSessionInWebUi` | `session-watcher.ts` |
| **询问卡等待（v0.8.4）** | Agent 提问（`ask_user_question`）或计划审批（`exit_plan_mode`）阻塞等用户输入时通知，回答后自动撤销操作中心残留 toast | `session-watcher.ts`（pending 配对状态机）+ `zstd-worker.cjs`（askOpens/toolResultCallIds） |
| **服务事件** | 服务就绪 / 异常 / 崩溃重启 | `index.ts` statusChange |
| **更新就绪** | electron-updater 下载完成 | `updater.ts` |

#### 询问卡等待的检测原理（v0.8.4 取证）

内核的 `user-questions/request` 是仅经 WebSocket 实时推送的 waterfall 事件（`packages/interaction/user-questions`），**不写入会话日志**（扫描全部 206 个真实会话验证），壳侧 log 轮询对卡片是盲的。但工具调用与结果都会落盘，构成可靠的影子信号：

- `tool/call`（`data.name` ∈ 白名单 `ask_user_question`/`exit_plan_mode`）入日志而同 `callId`（`data.message.source.callId`）的 `tool/result` 未出现 ⇒ 卡片等待中；result 配对到达 ⇒ 已回答。真实数据验证：38 次调用全部可配对、零误配（call 与 result 相邻 seq、间隔即等待时长）。
- 严格按工具名过滤：其他工具「call 无 result」只是慢执行（如 pwsh），不是卡片。
- 崩溃/中止收敛：`turn/end(kind=interrupted/aborted)` 按轮清 pending；call+result 同批帧（秒答）不触发；watcher 启动前已挂的卡片不回填（与 turn/end 基线语义一致）。

历史提交显示这功能被反复修过（v0.4.1 延迟与点击定位、v0.5.0 事件驱动、v0.5.1/5.2 点击跳转、v0.5.4 turn 去重 / interrupted 过滤），说明根因没被根治。

### 1.2 问题根因（已取证）

| 用户问题 | 根因 | 证据 |
| :--- | :--- | :--- |
| **通知不弹 / 漏报** | ① **AUMID 不一致**：`index.ts` 设 `app.setAppUserModelId('io.dsh.desktop')`，而 `electron-builder.yml` 的 `appId` 是 `io.dsh.exoskeleton`。Windows toast 通知要求 AUMID 与开始菜单快捷方式一致，不一致会被系统静默丢弃。② **dev / portable 无快捷方式**：开发模式（electron-vite dev）与 portable 单文件版不建开始菜单快捷方式，toast 天然不可靠。③ 窗口聚焦时系统可能抑制通知。 | `src/main/index.ts:25` vs `electron-builder.yml:1`；Windows toast 快捷方式约束 |
| **点击跳错会话 / 跳不过去** | `activateSessionInWebUi` 靠读取 React fiber（`__reactFiber$`）拿 `node.id` + 标题/时间多候补回退模拟点击，SPA 结构一变就偏；是「从壳外猜页面 DOM」的脆弱做法。 | `window-manager.ts:229-336` |
| **每轮对话都通知，太吵** | `session-watcher` 按轮语义（每轮 `turn/end` 立即通知）且无聚合窗口，多轮会话期间高频打扰。 | `session-watcher.ts:135-152` |

### 1.3 设计目标

1. **壳核分离不破坏**：检测逻辑（zstd watcher / 服务健康 / 更新）留在主进程，一个不动；
2. **显示层可插拔**：`notify` 升级为**通知事件中枢 + Provider**，原生 / 页面内 toast / 未来任意渠道（IM、邮件…）自由替换；
3. **插件可完整接管显示与交互**：点击跳转不再依赖 DOM hack（由页面内插件用官方 client runtime 程序化选中会话）；
4. **向后兼容、默认零回归**：默认行为与现状一致（会话每轮通知 + 原生弹窗），只是多了「插件接管」这条新通道。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     DSH-Exoskeleton 桌面壳（主进程）                 │
│                                                                  │
│  检测层（不动）            通知事件中枢 notification-hub（新增）       │
│  ┌──────────────────┐    ┌─────────────────────────────────┐      │
│  │ session-watcher  │───▶│ dispatch(NotificationEvent)      │      │
│  │ dsh-manager 状态  │───▶│  ├─ 聚合策略（session-done）      │      │
│  │ updater          │───▶│  └─ Provider 路由（auto/native/   │      │
│  └──────────────────┘    │     webview）                     │      │
│                          └───────────────┬──────────────────┘      │
│  ┌─────────────────────┐                │                          │
│  │ nativeProvider（现   │                │ webviewProvider          │
│  │ notify.ts 保留为内部）│                │  └─ 通过 WebContentsView │
│  └─────────────────────┘                │     预加载桥投递          │
└──────────────────────────────────────────┼───────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  dsh web（WebContentsView 承载，sandbox + contextIsolation）        │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ 预加载脚本 dsh-view（新增）                                    │   │
│  │   window.__dshExo.onEvent / send（最小白名单桥）               │   │
│  └────────────────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ DSH 插件 dsh-notify（页面内，纯 slot 渲染）                   │   │
│  │   · 订阅 __dshExo.onEvent → 渲染 toast 栈                    │   │
│  │   · 点击 → __dshExo.send('notify:click', {sessionId})        │   │
│  │   · 程序化选中会话（官方 client runtime，替代 DOM hack）【待验证】│   │
│  │   · 无壳时降级：订阅 sessions store 自绘 turn 完成 toast       │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**核心原则**：
- 事件是「事实」，显示是「策略」——检测层只产出事件，不关心谁弹、怎么弹；
- 主进程永远有 nativeProvider 兜底，插件缺失/页面离线不造成功能回归；
- 插件侧只拿到**白名单事件**，不暴露任意 IPC，符合安全隔离（R 系列约束延续）。

---

## 3. 数据模型

### 3.1 通知事件（类型化，`shared/types.ts` 新增）

```ts
export type NotificationEventKind =
  | 'session-done'        // 一轮对话完成
  | 'session-ask'         // 询问卡等待回答（v0.8.4）：Agent 提问/计划审批阻塞等用户输入
  | 'service-ready'       // 服务就绪
  | 'service-error'       // 服务异常
  | 'service-restarting'  // 崩溃自动重启
  | 'update-ready'        // 更新下载完成待安装

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
  /** 原生 provider 专用：主进程侧点击动作 */
  actions?: { onClick?: () => void }
}
```

### 3.2 Provider 注册表（`src/main/notification-hub.ts` 新增）

```ts
export interface NotificationProvider {
  id: 'native' | 'webview' | string
  /** webview provider 在线判定：桥已握手才投递 */
  ready(): boolean
  handle(ev: NotificationEvent): boolean   // 返回是否成功投递（hub 记录回执）
}
```

### 3.3 配置新增（`AppConfig`）

```ts
// 通知显示渠道：auto = webview 在线优先，否则 native
notifyChannel: 'auto' | 'native' | 'webview'       // 默认 'auto'
// 对话完成通知粒度（向后兼容旧 boolean）
notifySessionDone: 'off' | 'per-turn' | 'aggregate' // 默认 'per-turn'（现状行为）
// 聚合窗口：同一会话 N ms 内的多轮合并为「已完成 N 轮」
notifyAggregateWindowMs: number                     // 默认 5000（review 修正：原 20000 会让单轮延迟整个窗口）
// 服务事件开关（保留原字段）
notifyServiceEvents: boolean
```

**迁移**：读旧 `notifySessionDone: boolean` 时 `true→'per-turn'`、`false→'off'`；写入一律存新枚举。`session-watcher` 的开关判断改为 `!== 'off'`。

> **聚合窗口取舍（P1 review）**：聚合语义上「首轮必须缓冲到窗口结束才 flush」，
> 因此单轮通知也最长延迟一个窗口（默认 5s）。这是「N 轮 → 1 条」的固有代价；
> 若不可接受，可回退 `per-turn` 或用更短窗口。

---

## 4. 主进程侧改造

### 4.1 notification-hub.ts（新模块）

- `dispatch(ev)`：按 `notifyChannel` 选 provider（auto 逻辑见 §5.2）→ 投递 → 记录回执（成功/失败）到日志；
- **聚合策略**（只作用于 `session-done`）：`aggregate` 模式下同一 `session.uuid` 在 `notifyAggregateWindowMs` 内到达的多轮事件合并为一条「项目「X」· 已完成 N 轮」；`per-turn` 模式原样投递；`groupBy` 按 **session uuid**（不是标题，防同名会话误合并）；
- 失败处理：provider 返回 false 时按「webview → native → 托盘」降级链重试一次，仍失败记 `logger.warn`（漏报可查）。

### 4.2 事件产生点改造（只改投递目标，不动检测逻辑）

| 现代码 | 改为 |
| :--- | :--- |
| `session-watcher.ts:199` `notify('DSH 对话完成', …)` | `hub.dispatch({ kind:'session-done', …, actions:{ onClick } })` |
| `index.ts:96/103/105` 服务事件 | `hub.dispatch({ kind:'service-ready' | 'service-error' | 'service-restarting', … })` |
| `updater.ts:65` | `hub.dispatch({ kind:'update-ready', … })` |
| `notify.ts` | 保留，降为 `nativeProvider` 内部实现（不动其现有逻辑） |

### 4.3 立即修复：AUMID 对齐（独立于插件化，建议先行，单独 patch 发布）

- `index.ts:25` `app.setAppUserModelId('io.dsh.desktop')` → **`'io.dsh.exoskeleton'`**（与 `electron-builder.yml` 的 `appId` 一致）；
- NSIS 安装版已建开始菜单/桌面快捷方式 → 打包版 toast 恢复可用；
- **dev 模式与 portable 版**（无开始菜单快捷方式）：Windows toast 本就不可靠 → 由 `notifyChannel='auto'` 自动落到 webview/托盘，保证「至少可见」；在管理面板「设置」页展示当前渠道可用性自检结果（§8）；
- 约束：`setAppUserModelId` 必须在首次创建通知之前调用（当前在 bootstrap 早期，已满足）。

---

## 5. WebContentsView 桥（webview provider）

### 5.1 预加载脚本 `src/preload/dsh-view.ts`（新增）

- 在 `window-manager.ts` 的 `attachDshView` 里给 `WebContentsView` 的 `webPreferences` 增加 `preload`（保持 `sandbox:true` + `contextIsolation:true`）；
- 与主壳 renderer 的 preload **分开**（不同 world、不同 API，互不干扰）；
- 通过 `contextBridge` 暴露**最小白名单** API：

```ts
window.__dshExo = {
  /** 订阅壳推送的通知事件，返回取消函数 */
  onEvent(cb: (ev: NotificationEvent) => void): () => void,
  /** 页面 → 壳：点击 / 更新安装 / 已读回执 */
  send(channel: 'notify:click' | 'notify:install' | 'notify:seen', payload: { id: string; sessionId?: string }): void,
  /** 页面 → 壳：握手（插件就绪后才投递，防事件丢失） */
  ready(): void,
  appInfo(): { version: string }
}
```

- 页面 → 主：preload 用 `ipcRenderer.send('dsh-exo', channel, payload)`；主进程用 `view.webContents.on('ipc-message', …)` 接收（作用域限定该 view，不污染 `ipcMain` 全局通道）；
- 主 → 页面：`view.webContents.send('dsh-notify:event', ev)`，preload 转发给 `onEvent` 订阅者；
- `notify:install`（P2 review 修正）：更新就绪 toast 点击 → 壳侧 `updater.install()`；
- **P4 review 修正**：`appInfo()` 不再经 `ipcRenderer.invoke('app:getVersion')` 取版本（该 handler 全局注册、页面可达，与 R-27 不符），改为返回空版本占位；版本信息改由推送事件载荷携带。

### 5.2 webview provider 在线判定与 auto 决策

```
webview 在线 = view 已 attach（服务 running） && 收到过页面 __dshExo.ready() 握手
auto 决策    = webview 在线 && DSH 窗口是前台焦点 && notifyChannel=auto → webview
              否则 → native（→ 托盘降级链）
```

- **窗口激活（焦点感知，现场修复）**：页面内 toast 只在 DSH 窗口是前台焦点（用户正看着）
  时使用；失焦（最小化/隐藏/被其他窗口盖住/管理面板打开）时用户看不到页面内 toast，
  `auto` 必须走 native 原生通知，否则会漏看。探针由 window-manager 注册
  （`notificationHub.setWindowActive`：`isFocused() && !adminPanelVisible`），hub 不 import window-manager（保持解耦）；
- 未握手不投递：避免「事件先于页面就绪被丢」的漏报；握手丢失会触发 native 兜底；
- 双击通道防重复：`auto` 下 webview 与 native 互斥；若用户手动 `native`+`webview` 并存（后续扩展），按事件 `id` 去重。

### 5.3 安全

- API 最小白名单、payload 类型化、不含任意 IPC 透传；
- 页面侧异常全部静默降级（try/catch + 日志），不影响壳主进程；
- 新增不变量 **R-27**：webview 预加载只暴露 `__dshExo` 白名单，非本壳 renderer 一律不可达管理 IPC。

---

## 6. DSH 插件侧：dsh-notify（独立仓库 qgx1992/dsh-notify）

### 6.1 插件形态

- **归属：独立 GitHub 仓库 `qgx1992/dsh-notify`**（桌面端仓库不再维护插件源码，`plugins/` 已 gitignore）。
  安装走 `dsh plugin --profile web add github:qgx1992/dsh-notify`；桌面端**不再将其列入推荐列表**（`recommended-plugins.ts`），按需自行安装；
- 遵守 `dsh-ui-tools` 已验证的规则：**纯自建覆盖层、不搬 DSH slot 节点**（规避渲染进程 100% CPU 卡死）、独立 locale NS / data 前缀；
- `package.json`：`dsh.client.platform = "web"`，`inject` 留空（运行时动态订阅 `window.__dshExo`，不静态注入到 DSH 源码上下文）。

### 6.2 页面内渲染

- 全局 toast 栈（右上角），按 `kind` 分级样式（成功/错误/信息/警告）；
- **对话完成 toast**：`项目「X」· 标题（第 N 轮）`；点击 → 激活会话（§6.3）；
- **服务异常/重启 toast**、**更新就绪 toast**：更新就绪点击 → `notify:install`（P2 review 修正：不再只是唤起窗口，而是触发壳侧 `updater.install()`）；meta 文案分级（「点击重启安装」/「点击查看会话」）；
- 可选增强（后续）：未读徽章、声音提醒。

### 6.3 激活会话（替代 DOM hack）—— 本方案的关键收益

- **首选**：插件在 DSH 页面内，可直接用官方 `@deepseek-ai/dsh-client-runtime/client` 的 `sessions` store **程序化选中/打开目标会话**（不再从壳外猜 DOM、不再依赖 `__reactFiber$`）；
- **点击链路**：toast 点击 → `window.__dshExo.send('notify:click', { id, sessionId })` → 壳 `windowManager.show()` + 插件侧程序化激活（会话 ID 精确，天然消除同标题误点）；
- **回退**：若 client runtime 未暴露程序化 API（见 §11 待验证），保留现有 `executeJavaScript` 定位路径作为兜底；
- 如此「点击跳转」从壳的脆弱 DOM hack 迁移到插件内可控实现，壳只负责唤起窗口。

### 6.4 无壳降级

- 页面**无** `window.__dshExo`（直接用浏览器开 dsh web，无桌面壳）→ 插件仍可用：订阅 `sessions` store 自绘 turn 完成 toast（页面内闭环，无 OS 通知）；
- 壳在线但插件未装 → `auto` 决策落到 native，行为同现状，零回归。

---

## 7. 三个问题的解决映射（验收标准）

| 问题 | 方案 | 验收标准 |
| :--- | :--- | :--- |
| **通知不弹 / 漏报** | AUMID 对齐（P0 先行）+ `auto` 降级链（native→webview→托盘）+ hub 投递回执日志 | 打包版弹原生 toast；dev/portable 至少页面内可见；hub 日志有每次投递成败记录；人为触发服务异常必有一条通知或日志回执 |
| **点击跳错会话 / 跳不过去** | 插件程序化激活（会话 ID 精确，替代 fiber hack）+ 保留 executeJavaScript 兜底 | 连续 10 次点击通知后，选中态均为目标会话（ID 校验通过） |
| **每轮对话都通知，太吵** | `aggregate` 聚合策略（默认窗口 5s，按 session uuid 合并为「已完成 N 轮」；单轮最长延迟一个窗口，见 §3.3 取舍说明） | 同一会话窗口内 10 轮连发只产生 1 条聚合通知；`per-turn` 模式可一键恢复现状 |

---

## 8. 配置与 UI（管理面板「设置」页）

| 设置项 | 选项 | 默认 |
| :--- | :--- | :--- |
| 通知渠道 | 自动 / 原生 / 页面内 | 自动 |
| 对话完成 | 关 / 每轮 / 聚合（可调窗口秒数） | 每轮（后续建议默认改聚合） |
| 服务事件通知 | 开 / 关 | 开 |
| 渠道自检 | 只读展示：native 可用性、webview 握手状态、当前生效渠道 | — |

---

## 9. 风险与回滚

| 风险 | 缓解 |
| :--- | :--- |
| dsh web 升级改变 client runtime API | 插件降级为 DOM 兜底；壳侧（检测/事件）完全不受影响；升级后回归验证 |
| 向第三方页面注入 preload | 最小白名单 + sandbox；异常静默；命名 `__dshExo` 冲突检测（页面无同名全局时再注入） |
| 双通道重复弹通知 | `auto` 下互斥；并存时按事件 `id` 去重 |
| 聚合误合（不同项目同名会话） | `groupBy` 按 session uuid 而非标题 |
| 插件装/卸与配置迁移 | 插件可卸（回 native，行为=现状）；配置枚举向后兼容旧 boolean；壳旧版本可回退 |
| 漏报回归 | 所有投递写回执日志，P0 后先跑一轮回归对比 |

**新增不变量**：R-26（通知事件去重与投递回执）、R-27（webview 预加载最小白名单 API）。

---

## 10. 分阶段实施（状态：已在 `test/notify-plugins` 分支实现，见下方）

| 阶段 | 内容 | 发布 |
| :--- | :--- | :--- |
| **P0** | AUMID 对齐（一行修复）+ 管理面板渠道自检占位 | 独立 patch，先行验证「不弹」是否解决 |
| **P1** | `notification-hub` 重构：所有调用点改走 hub，native 行为不变 | patch，回归验证零行为变化 |
| **P2** | webview 桥：`dsh-view` preload + 握手 + 投递 | patch，验证通道连通 |
| **P3** | `dsh-notify` 插件：toast 栈 + 点击回传 + 无壳降级；`notifyChannel` 生效 | patch |
| **P4** | 聚合策略 + 程序化激活（待验证后）+ 设置页 UI 完善 | patch |

**实现状态**（本次同步交付，分支 `test/notify-plugins`，壳侧改动**不进 `main`**）：
- P0–P4 主体已实现并测试通过（typecheck / build / `npm test`（含 config 迁移、notify:install、dsh-view preload 集成测试）/ 插件 smoke）；
- Review 修正已合入：P1 聚合默认窗口 5s、P2 `notify:install` 通道、P3 native 回执真实化（`notify()` 返回 boolean）、P4 移除 `app:getVersion` invoke；
- 插件源码已**独立到 `qgx1992/dsh-notify`**（桌面端仓库不再维护，`plugins/` gitignore）；桌面端**不再将其列入推荐列表**，按需自行安装；
- **现场修复（点击不跳转，日志证据）**：
  1. webview 握手被 `did-finish-load` 覆盖 → 长期离线 → 通知全降级原生。改为 `did-start-loading` 复位（加载开始即复位，页面 JS 与插件握手在其后执行，顺序稳定）；
  2. 原生通知点击优先转发 webview 插件 `sessions.open(id)` 激活（`hub.requestActivate` + 插件 `session-activate` 控制事件，不渲染 toast），webview 离线才回退 DOM hack；
  3. `auto` 路由加入**窗口激活（焦点感知）**：DSH 窗口非前台焦点（失焦/最小化/隐藏/被盖住）
     时页面内 toast 不可见，必须走原生通知（`hub.setWindowActive` 探针，防漏看）；
- **现场修复（v0.8.2，操作中心点击 + 置顶，日志与 E2E 证据）**：
  1. **操作中心残留 toast 点击无效且不消失**：Electron 34 的 Windows toast 无可用激活机制
     （[electron/electron#32585](https://github.com/electron/electron/issues/32585) 确认）——
     toast 进操作中心后再点击不产生事件、系统也不移除。修复：`notify.ts` 改用自定义
     `toastXml` 协议激活（`activationType="protocol"` + `launch="dsh-exo://notify?…"`），
     点击（弹出/操作中心/冷启动）统一拉起 `dsh-exo://` 协议 → 单实例
     `second-instance`/冷启动 argv → `notify.activateFromUrl()` 命中注册表回放原
     `actions.onClick` + `close()` 移除；未命中（冷启动）由 `index.ts` 兜底唤起窗口 +
     定位会话（等待 DSH 视图挂载最多 15s）。Windows 在协议激活成功后自动从操作中心移除。
  2. **点击通知不置顶**：`windowManager.show()` 前台锁对策改为「先 `setAlwaysOnTop(true)`
     → `moveTop`/`focus` → 250ms 后撤销」；旧 `setTimeout(0)` 置顶/撤销被 OS 合并成
     no-op，实测失效。协议激活还顺带获得 Windows 授予的前台权，双保险。
  3. **双重处理去重**：E2E 实测一个真实 toast 点击会同时触发 Electron 实例 `click` 与
     协议启动——协议 toast 不再挂实例 `click`，点击只走协议单路径。
  4. **协议注册**：`app.setAsDefaultProtocolClient('dsh-exo')` 每次启动幂等注册
     （dev 需传 `process.execPath` + 入口路径）；注册失败自动退回普通 toast（实例 click 兜底）。
- 剩余待办：§11 的 1/3 需在真实 `dsh web` 环境实测（程序化激活、dev/portable toast 行为）。

每阶段：`npm run typecheck` + `npm test` + 实测验证 → `npm version patch` → 中文 changelog（遵守 AGENT.md §0）。

---

## 11. 待验证清单（动手前先取证）

1. ~~`dsh-client-runtime` 的 `sessions` store 是否暴露**程序化选中/打开会话**的 API~~ —— **已确认**（`lib/types/client/contract/sessions.d.ts`：`ISessions.open(id)` = 把会话选中为 current，`must exist in the list`）；
2. dsh web 页面是否容忍注入 `__dshExo` 全局（命名冲突 / CSP 检查）；
3. Windows 下 dev / portable 版 toast 实际行为（记录证据，验证 AUMID 修复效果）；
4. `WebContentsView` + `sandbox:true` + preload + `contextBridge` 的兼容性小样验证（已通过 `test-dsh-view` 集成测试）；
5. 聚合窗口的合理默认值（5s 需实测多轮会话观感）。
