# dsh-ui-tools 内核版本自适应设计（方案 B：软依赖 + 子 fiber 隔离）

> 面向 **dsh-ui-tools 插件仓库**（github.com/qgx1992/dsh-ui-tools）的落地设计文档。
> 目标读者：插件维护者（或接手实施的 Agent）。本文档所有结论均有源码/实测证据，见 §2、§3 与附录 A。
> 关联：DSH-Exoskeleton 侧的兜底保险丝见 `src/main/kernel-compat.ts` 的 `COMPAT_PATCHES`（方案 A，§9）。

## 1. 现象

在 Exoskeleton 桌面端把默认内核切到旧版本（`0.1.1-rc.1` / `0.1.1-rc.2`）后，DSH Web UI 顶部出现红色横幅，反复重载（桌面端自愈最多 30 次）：

```
Failed to load plugins
web boot: 1 entry did not activate
dsh-ui-tools: pending (waiting for services: uiConversation, uiSession)
```

要点：
- **只有这 1 个 entry 未激活**，其余插件正常；服务其实活着（API 可用）。
- 内核 `0.1.2-alpha.1` / `alpha.2` 无此现象。
- 性质 = 插件的 client 入口声明了**旧内核不存在的服务的硬依赖**。

## 2. 根因（三段证据）

### 2.1 插件侧：入口 fiber 声明了 alpha-only 服务

`dsh-ui-tools@0.4.1` 的 client 入口（`lib/client.js`，等价源码 `src/client/index.ts`）：

```js
const inject = ["slots", "modelDirectories", "sessions", "locale", "workspaces",
                "uiConversation", "uiSession"]   // ← 后两项是硬依赖
```

使用点（同文件）：

```js
// 「修改的文件选项卡」读 ChatSnapshot：与官方 dsh-client-ui-chat 的 chatSource 同构
const target = ctx.uiConversation.binding(binding).target(MFS_CHAT_TARGET)
ctx.uiSession.provide({ /* session header 标准 hook */ })
```

### 2.2 内核侧：旧内核没有这两个服务的提供方

| 内核 | `dsh-client-ui-session` | `dsh-client-ui-chat` | 结论 |
|------|------------------------|----------------------|------|
| `0.1.1-rc.2` | ❌ store 里无此包 | ❌ store 里无此包 | `uiSession` / `uiConversation` **均无提供方** |
| `0.1.2-alpha.2` | ✅ 有（`super(ctx,'uiSession')`） | ✅ 有 | 两服务齐备 |

（`0.1.1-rc.2` 仅有 `dsh-client-ui-conversation`，它提供的是 `conversation` 服务，**不是** `uiConversation`。）

### 2.3 审计侧：loader entry 停在 pending 即判失败

`@deepseek-ai/cordis` 的 `inject` 是**硬声明**：依赖服务缺失时该 fiber 停在 `PENDING`（不报错、不执行 apply 体）。而 boot 末尾审计（`packages/boot/app-boot/src/index.ts` 的 `assertEntriesActivated`）：

```ts
for (const entry of ctx.loader.entries()) {      // ← 只遍历 loader entries
  if (state === FIBER_PENDING) {
    const missing = Object.keys(fiber.inject).filter(s => fiber.ctx.get(s) === undefined)
    failures.push(`${entry.options.name}: pending (waiting for services: ${missing.join(', ')})`)
  }
}
throw new Error(`${binName}: ${n} entry did not activate\n${failures.join('\n')}`)
```

→ 因为 `uiConversation`/`uiSession` 写在 **entry 层**的 `inject` 上，旧内核下整个 entry 永不激活 → 抛错 → Web UI 显示 `Failed to load plugins`，功能全丢（连不依赖新服务的四个功能也一起没了）。

## 3. 技术依据（方案可行性支点）

1. **cordis 支持非严格读服务**（`@deepseek-ai/cordis/lib/index.js` 的 `Context.get`）：
   ```js
   /** Read a service from the store without the inject requirement.
    *  @param strict — when true, only return implementations whose providing fiber is currently active.
    *  @returns the service value, or undefined when not (yet) provided. */
   get(name, strict = true) { ... }
   ```
2. **审计只覆盖 loader entry 的 fiber**（见 §2.3）→ **`ctx.plugin()` 挂载的子 fiber 不在审计范围**，它停在 pending 完全无害。
3. **pending 不是错误**：cordis 允许 fiber 停在 `PENDING`（服务出现即自动激活），不执行 apply 体、不注册任何 effect，随父 fiber dispose 一并释放。

## 4. 设计方案

**核心思想**：把「依赖声明的粒度」降为「功能开关的粒度」——入口层只声明跨内核的服务，alpha-only 功能收进**子 fiber**，让旧内核静默降级而不是让整个入口卡死。

```
apply(ctx)                          ← loader entry fiber
 │   inject = ['slots','modelDirectories','sessions','locale','workspaces']   // 跨内核
 ├── registerModelSeat(ctx)         功能一：模型选择双按钮
 ├── registerWorkspaceCollapse(ctx) 功能二：侧边栏工作区折叠
 ├── registerSessionBadge(ctx)      功能四：会话标题旁工作区徽章
 ├── registerSettingsSection(ctx)   功能五：插件设置页（DSH UI 工具）
 │
 └── ctx.plugin(alphaFeatures)      ← 子 fiber，inject = ['uiConversation','uiSession']
       registerModifiedFilesTab(ctx)   功能三：修改的文件选项卡（target 体系）
```

### 行为矩阵（验收基线）

| 内核 | entry fiber | alpha 子 fiber | boot 审计 | 横幅 | 功能 |
|------|------------|---------------|-----------|------|------|
| `0.1.2-alpha.1+` | active | active | pass | 无 | 全部 5 项 |
| `0.1.1-rc.x` | active | **pending（静默）** | **pass** | **无** | 1/2/4/5 正常，功能三缺席 |

## 5. 代码骨架（`src/client/index.ts`）

```ts
/** 入口层只声明「所有受支持内核都有」的服务 —— 这是消除旧内核横幅的关键。 */
export const inject = ['slots', 'modelDirectories', 'sessions', 'locale', 'workspaces']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-tools: locale bundles')

  registerModelSeat(ctx)          // 功能一
  registerWorkspaceCollapse(ctx)  // 功能二
  registerSessionBadge(ctx)       // 功能四
  registerSettingsSection(ctx)    // 功能五

  // 功能三（「修改的文件」选项卡）依赖 0.1.2-alpha.1 才引入的 client target 体系
  // （uiConversation.binding(...).target('chat') + uiSession.provide）。
  // 收进子 fiber：新内核正常激活；旧内核停在 pending —— 不报错、
  // 不计入 loader entry 审计（app-boot assertEntriesActivated 只遍历 ctx.loader.entries()）。
  ctx.plugin(alphaFeatures)
}

/** 仅在提供 uiConversation / uiSession 的内核上激活；旧内核上本函数体不会执行。 */
function alphaFeatures(ctx: Context): void {
  const target = ctx.uiConversation.binding(binding).target('chat')   // ChatSnapshot
  ctx.uiSession.provide({ /* session header 标准 hook */ })
  registerModifiedFilesTab(ctx, target)                               // 功能三
}
alphaFeatures.inject = ['uiConversation', 'uiSession']                // 硬依赖收敛到子 fiber
```

实施注意：
- **归属核对**：请在插件源码里确认哪些函数真正触碰 `ctx.uiConversation` / `ctx.uiSession`（编译产物可 grep `uiConversation\|uiSession` 定位），只把这些搬进 `alphaFeatures`；`ctx.sessions` / `ctx.workspaces` / `ctx.slots` 属跨内核，留在入口层。
- **保持纯 slot 渲染**：不得用 MutationObserver/定时器搬运 slot 节点（历史踩坑：与框架重渲染互相触发 → 渲染进程 100% CPU 卡死）。本改造不改变渲染方式。
- **设置页体验**（可选增强）：用 strict 读取探测能力，旧内核上把「修改的文件选项卡」开关灰显并提示所需内核：
  ```ts
  const hasAlphaApi = ctx.get('uiConversation') !== undefined && ctx.get('uiSession') !== undefined
  ```
  （`get` 默认 `strict=true`，只认「提供方 fiber 已激活」。）

## 6. 实施步骤

1. 在 dsh-ui-tools 仓库改 `src/client/index.ts`：
   - `inject` 移除 `uiConversation`、`uiSession`
   - 新增 `alphaFeatures` 子 plugin（承载这两个服务的全部用法），`apply()` 里 `ctx.plugin(alphaFeatures)`
2. `npm run typecheck && npm run build`（产出 `lib/client.js`）
3. 本机 profile 重装验证（见 §7 用例），通过后 `npm version patch && git push && git push --tags`
4. 使用侧更新：`dsh plugin --profile web add github:qgx1992/dsh-ui-tools` → **重启 dsh web**（client bundle 在启动时组合，仅刷新页面不生效）
5. 插件 README 记录「内核兼容矩阵」（§4 表）

## 7. 验证清单（关键回归）

**A. 旧内核静默降级（本方案的核心目标）**
```
切默认内核到 0.1.1-rc.2 → 打开 Web UI
  ✅ 无 "web boot: 1 entry did not activate" / 无 Failed to load plugins 横幅
  ✅ 功能一/二/四/五 正常（模型双按钮、工作区折叠、会话徽章、设置页）
  ℹ️ 功能三（修改的文件选项卡）自然缺席
  ✅ 控制台无 dsh-ui-tools 相关异常
```

**B. 新内核全功能（防回归）**
```
切回 0.1.2-alpha.2 → 五个功能全部生效，设置页开关可用，无横幅
```

**C. Exoskeleton 侧观测点**
```
%APPDATA%\DSH-Exoskeleton\dsh-desktop.log
  不再出现 dsh view plugin-load check / shows plugin load failure; reloading
```

## 8. 发布与回滚

- 更新：`dsh plugin --profile web add github:qgx1992/dsh-ui-tools`（或 `upgrade`），随后重启服务。
- 回滚：`dsh plugin --profile web add github:qgx1992/dsh-ui-tools#<上一个提交 sha>` → 重启。
- 若只想在旧内核上临时停用（未及改插件时），走 §9 的方案 A（Exoskeleton 兼容补丁，按 loader 行 id `ui-tools` 禁用）。

## 9. 与 Exoskeleton 方案 A 的关系（互补，不冲突）

| | 方案 A（保险丝） | 方案 B（本文档，根治） |
|---|---|---|
| 改动位置 | DSH-Exoskeleton `COMPAT_PATCHES` 注册表，对 `0.1.1-rc.x` 注入 `- id: ui-tools\n  disabled: true` | dsh-ui-tools 插件自身 |
| 生效范围 | 该内核上整个插件被禁用（旧内核本来也没功能） | 旧内核保留其余四项功能，仅功能三缺席 |
| 优点 | 一行注册表、立即见效、不改内核不写用户 profile（官方 `--patch` 一等机制） | 根治：能力分级、跨内核一套代码 |
| 定位 | 上游未修时的兜底 | 长期正解 |

两者可并存：B 落地后，A 的 `ui-tools` 禁用行可保留（无副作用）或移除。

## 10. 风险与边界

| 风险 | 对策 |
|------|------|
| 服务「存在但语义又变了」（比目标更晚的内核车次再改 target 体系） | 子 fiber 的 `inject` 只保证「存在且激活」；关键调用点加 `try/catch` 与形状探测（`typeof ctx.uiConversation?.binding === 'function'`） |
| 设置页出现无效开关 | 用 strict `ctx.get()` 探测并灰显 + 文案标注「需 0.1.2-alpha.1+」 |
| 官方再次重命名服务 | alpha-only 依赖集中在 `alphaFeatures` 单一函数，改动面收敛 |
| 子 fiber 生命周期 | 随父 entry dispose 自动释放（cordis fiber 父子链），无泄漏 |
| 未来若需要「服务后到」时补挂功能 | `inject` 硬声明即可（子 fiber 会在服务出现时自动激活），无需自行轮询 |

## 附录 A：证据复现命令

```bash
# 1) 插件入口的硬依赖
grep -o 'const inject = \[[^]]*\]' ~/.dsh/profiles/web/node_modules/dsh-ui-tools/lib/client.js

# 2) 旧内核缺少两个 client 服务提供方（对比 alpha.2）
K=~AppData/Roaming/DSH-Exoskeleton/kernels
ls $K/0.1.1-rc.2/node_modules/.pnpm/node_modules/@deepseek-ai/ | grep -E "ui-session|ui-chat"
ls $K/0.1.2-alpha.2/node_modules/.pnpm/node_modules/@deepseek-ai/ | grep -E "ui-session|ui-chat"

# 3) 审计逻辑（为何 pending 即判失败、且只针对 loader entry）
#    deepseek-harness: packages/boot/app-boot/src/index.ts  →  assertEntriesActivated

# 4) 非严格读服务（可选依赖的基础）
#    @deepseek-ai/cordis  →  Context.get(name, strict = true)
```

---

文档版本：v1.0（2026-08-31）｜撰写背景：DSH-Exoskeleton v0.8.3 排查「切换旧内核后 Web UI 报 Failed to load plugins」
