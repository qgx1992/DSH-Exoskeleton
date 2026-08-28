# dsh-notify

**DSH 通知显示层插件（可插拔通知显示层的 web 侧）**
全局右上角 toast 栈，订阅桌面壳 `__dshExo` 桥事件（对话完成 / 服务事件 / 更新就绪），点击经官方 `dsh-client-runtime` 的 `sessions` store **程序化激活会话**（替代壳侧 `__reactFiber$` DOM hack）；无壳时自动降级订阅 `sessions` store 自绘轮次完成 toast。

> 面向 DSH-Exoskeleton 设计文档 [`docs/NOTIFICATION-PLUGIN-DESIGN.md`](https://github.com/qgx1992/DSH-Exoskeleton/blob/main/docs/NOTIFICATION-PLUGIN-DESIGN.md) §6 实现。壳核分离不破坏：检测逻辑（zstd watcher / 服务健康 / 更新）留在主进程，本插件只负责**显示与交互**。

---

## 1. 解决什么问题

| 用户问题 | 本插件对应的解法 |
| :--- | :--- |
| **通知不弹 / 漏报** | 桌面壳把事件经 webview 预加载桥（`__dshExo`）投递给页面内插件 → `auto` 决策「webview 在线优先」，dev/portable 无 System Toast 时通知仍然在页面内可见 |
| **点击跳错会话 / 跳不过去** | 插件在页面内直接用官方 `@deepseek-ai/dsh-client-runtime/client` 的 `sessions` store **程序化选中/打开会话（会话 ID 精确）**，不再从壳外猜 DOM、不依赖 `__reactFiber$` |
| **每轮对话都通知，太吵** | 显示层策略化：聚合窗口、每轮/聚合粒度由**壳侧 hub** 决定后下发（本插件只渲染）；无壳降级时同会话连发**原位刷新**而非堆积，避免覆盖层通知风暴 |

---

## 2. 架构（两种数据源，运行时互斥）

```
┌─ 壳桥模式（默认，覆盖式首选）────────────────────────────────────┐
│  DSH-Exoskeleton 主进程 notification-hub（壳侧，P1）              │
│   └─ webviewProvider（P2：WebContentsView 预加载桥 __dshExo）      │
│        │ onEvent(ev)                              send()           │
│        ▼                                                ▲          │
│  ┌─ dsh web 页面 ─────────────────────────────────────────────┐   │
│  │  dsh-notify 插件（本包）                                   │   │
│  │   · 检测到 window.__dshExo → ready() 握手 → 订阅 onEvent    │   │
│  │   · 渲染 toast 栈（按 kind 分级）                          │   │
│  │   · 点击 → ctx.sessions.open(id) 程序化激活                 │   │
│  │          → __dshExo.send('notify:click', …)                │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘

┌─ 无壳降级（浏览器直开 dsh web，无 __dshExo）───────────────────┐
│  dsh-notify 插件                                                │
│   · 订阅 ctx.sessions.list，检测 completed 0→1 边缘（= 侧边栏    │
│     绿色 "done"：运行中→完成且未选中）                            │
│   · 自绘「对话完成」toast；点击 → ctx.sessions.open(id)          │
│   · 页面内闭环，无 OS 通知                                        │
└────────────────────────────────────────────────────────────────┘
```

- **事件是"事实"，显示是"策略"**：本插件只渲染壳/列表喂给它的完成事件，聚合/渠道等策略由壳侧 hub 决策。
- 桥与降级互斥（有桥绝不再开 sessions 降级），天然无双通道重复。

---

## 3. 桥契约（`window.__dshExo`）

> 壳侧 P2 已落地（`src/preload/dsh-view.ts` + `window-manager.attachDshView` 挂 preload +
> `notification-hub` webview 通道），本契约即**当前实现**，供壳侧后续维护对齐。

插件只消费**最小白名单** API，不依赖任何任意 IPC：

```ts
// 壳侧 → 页面（预加载桥 window.__dshExo，经 contextBridge 暴露）
interface DshExoBridge {
  /** 订阅壳推送的通知事件，返回取消函数 */
  onEvent(cb: (ev: NotificationEvent) => void): () => void
  /** 页面 → 壳：点击 / 已读回执 */
  send(channel: 'notify:click' | 'notify:seen', payload: { id: string; sessionId?: string }): void
  /** 页面 → 壳：握手（插件就绪后才投递，防事件丢失） */
  ready(): void
  /** 壳版本探针（仅用于日志） */
  appInfo(): { version: string }
}

// 通知事件（与设计 §3.1 一致）
type NotificationEventKind =
  | 'session-done' | 'service-ready' | 'service-error' | 'service-restarting' | 'update-ready'

interface NotificationEvent {
  id: string
  kind: NotificationEventKind
  title: string
  body: string
  ts: number
  session?: { sessionDir: string; workspace: string; uuid: string; file: string; turn?: number; project?: string; sessionTitle?: string; firstUserText?: string }
  service?: { port?: number; error?: string; restartCount?: number }
  update?: { version?: string }
  actions?: { onClick?: () => void }   // 原生 provider 专用；webview 通道序列化后无回调
}
```

**桥侧交互时序**（壳实现参考）：

```
壳 webviewProvider 建桥（preload：sandbox+contextIsolation 暴露 __dshExo）
  → 等页面 __dshExo.ready() 握手
  → 握手后「webview 在线」，auto 决策投向 webview provider
  → view.webContents.send('dsh-notify:event', ev) → preload 转发给 onEvent 订阅者
  → 收到 notify:click → windowManager.show()（会话激活由插件侧 ctx.sessions.open 完成）
  → 收到 notify:seen → hub 记录已读回执（R-26）
未握手不投递（防漏报）；握手丢失 → native 兜底。
```

---

## 4. 安装

> **分发策略：本地插件，默认不上传 GitHub / 不发布 npm**（本机自用或随项目内网分发）。
> 安装一律走 `link:` 指向本地目录。

```bash
# 本地安装（本机 link: 指到仓库子目录）——推荐，也是当前唯一渠道
dsh plugin --profile web add link:D:/A-my\ project/研究agent桌面端/DSH-Exoskeleton/plugins/dsh-notify
# 桌面壳内也可用「插件」面板安装，或在 profile 里直接执行上述命令
```

> 若后续决定公开分发：再补 `github:qgx1992/dsh-notify` / `dsh-notify`(npm) 源，并走 README §9 的发布流程。
> 安装时若 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 未放行新依赖，
> 会报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（AGENT.md §7 已知坑），把版本加进白名单即可。

装完后：`dsh web` 重启生效（客户端 bundle 在启动时组合，仅刷页面不生效），
页面刷新即加载 `/plugins/dsh-notify/client.js`。

---

## 5. 行为细节

- **toast 栈**：右上角，全局。按 kind 分级：对话完成=信息、服务就绪=成功、服务异常=错误、服务重启=警告、更新就绪=信息（左侧竖色条 + DSW 主题变量，自动适配亮/暗色）。
- **自动关闭**：信息 8s / 成功 6s / 错误与更新 15s / 警告 12s；× 手动关闭；同屏上限 **5 条**（超出淘汰最旧）。
- **对话完成 toast**：`项目「X」· 标题`（壳下发 body 原样渲染；无壳降级由插件按 `cwd` 项目名 + `displayTitle` 组装）。点击 → `ctx.sessions.open(sessionId)` 程序化激活 + `notify:click` 回传。
- **激活可靠性与防御**：`open()` 前先校验会话 id 是否在列表（`unknown id` 会 fail loud，避免炸进插件）；列表瞬态（`phase=pending`）下每 500ms 重试至多 4 次；再点可按需复用 `byId` 精确 id。
- **已读回执**：事件渲染即 `notify:seen`（壳侧 hub 用以上报投递成功/去重）。
- **i18n**：独立 locale NS `dsh-notify`（zh/en）。**data 前缀**：`data-dsh-notify-*`。
- **DOM 纪律**：toast 栈是插件自建的 `fixed` 覆盖容器，**绝不搬动 DSH slot 渲染出的节点**（搬节点 ↔ 框架重渲染互相触发会导致渲染进程 100% CPU 卡死，见 AGENT.md 已知坑）；卸载插件（fiber dispose）整体拆除样式 + 根容器 + 全部 toast。
- **静默降级**：所有异常 try/catch，不向壳/页面抛。

---

## 6. 设计验证结论（对应设计文档 §11「待验证清单」）

| # | 待验证项 | 结论（本插件取证） |
| :-- | :--- | :--- |
| 1 | `dsh-client-runtime` 的 `sessions` store 是否暴露**程序化选中/打开会话**的 API | ✅ **存在**。`ISessions.open(id: SessionId): void`（"Select a session as current"），实现 `SessionRuntime.open`；`ctx.sessions` 可见（inject `"sessions"` 后）。§6.3 首选路径可行 |
| 2 | 页面是否容忍注入 `__dshExo` 全局 | 插件侧只**消费**，不注入；`__dshExo` 命名冲突检测由壳侧 preload 负责（R-27，页面无同名全局时才注入） |
| 4 | `WebContentsView` + sandbox + preload + contextBridge 兼容性 | 壳侧 P2 阶段验证；本插件按标准 `contextBridge` 契约实现，无特殊前提 |
| — | 覆盖式 toast 渲染安全性 | ✅ 与生态先例（dsh-pet）同型：自建 `position: fixed` 容器 + `<style>`，不搬 slot 节点 |

无壳降级的"轮次完成"信号：`SessionSummary.completed`（侧边栏绿色 done 标记，
`SessionManager` 在 running→idle 且未选中时 arming）。勘察结果见
`@deepseek-ai/dsh-client-runtime/lib/types/client/contract/sessions.d.ts` 与
`sessions/service.d.ts`。

---

## 7. 与 DSH-Exoskeleton 壳侧协作（P0–P2 已落地，P3/P4 约定）

壳侧已完成（本次同步交付，`npm run typecheck` / `npm test`（113 项）通过）：

- **P0 ✅**：AUMID 对齐（`index.ts` `setAppUserModelId('io.dsh.exoskeleton')`，与 `electron-builder.yml` appId 一致）。
- **P1 ✅**：`src/main/notification-hub.ts`（`dispatch` / 聚合策略 / Provider 路由 / 投递回执日志 R-26），原 `notify.ts` 降为 native 内部实现。
- **P2 ✅**：`src/preload/dsh-view.ts` 预加载桥（`window.__dshExo` 白名单，R-27）+ `window-manager.attachDshView` 挂 preload + hub webview 通道（在线判定 = view attach && 收到 `ready()` 握手）+ 三处事件源（session-watcher / index 服务事件 / updater）改走 hub。

**约定**：webview 通道下，壳收到 `notify:click` **只需 `windowManager.show()`**，会话激活由插件 `ctx.sessions.open()` 完成 —— 这是替换 `activateSessionInWebUi` DOM hack 的关键收益；壳侧 `activateSessionInWebUi` 保留为 native 通道 / 页面异常时的兜底（`actions.onClick` 携带）。

**P3 / P4（未做，按需后续）**：把 `dsh-notify` 加入 `RECOMMENDED_PLUGINS` 默认预置/推荐；管理面板「设置」页渠道自检 + 通知渠道/粒度/聚合窗口 UI（现状：`notifyChannel` 默认 `auto` 已生效，粒度默认 `per-turn` 保持现状零回归，聚合窗口默认 20000ms，均可在 `config.json` 手动调整）。

---

## 8. 目录结构

```
plugins/dsh-notify/
├── package.json          # dsh.client.platform=web；dsh.client.inject 留空（不静态注入源码上下文）
├── cordis.patch.yml      # bundle 挂载声明（insert 进 DSH 配置树）
├── lib/
│   ├── index.js          # 宿主（node 侧）入口：纯浏览器插件，无宿主行为
│   └── client.js         # 浏览器 bundle：toast 栈 + 桥订阅 + 程序化激活 + 无壳降级 + i18n
├── README.md             # 本文档
└── LICENSE               # MIT
```

## 9. 开发 / 发布

- 改 `lib/client.js` 后：`node --check lib/client.js` 语法校验 → **`node test/smoke.cjs` 冒烟测试**（在无浏览器环境用最小 DOM shim 真实执行 `apply()`，覆盖：bundle 导出形状 / 无壳降级 completed 边缘弹 toast / 程序化激活 / 更新就绪 notify:install / 同事件去重 / 卸载拆除）→ 本地 `link:` 重装 → 重启 dsh web 实测。
- **当前默认本地分发**：不推 GitHub、不 `npm publish`。版本语义化（改代码后 bump），README/description 维护好即可。
- 平台标记：`dsh.client.platform = "web"`；`exports['./client']` 供模块系统组合 `/plugins/dsh-notify/client.js`。