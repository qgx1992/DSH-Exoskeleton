# DSH 内核版本管理 · 多内核共存方案（设计文档）

> 状态：设计稿（未实现） · 对应目标：文档 §1.2「零门槛：下载安装即用，无需预装 Node.js / dsh」
> 模式参考：nvm / pyenv / volta 的「多版本共存 + 默认版本切换」

---

## 1. 目标与背景

当前应用通过探测**系统已安装的 dsh**（`DSH_EXECUTABLE` → npm 全局 → PATH）来启动 `dsh web`，
用户必须自行 `npm i -g @deepseek-ai/dsh`。本方案让应用**自行托管 DSH 内核**：

1. **零门槛**：装好应用即可用，无需用户碰 Node/npm/dsh
2. **多内核共存**：`0.1.0 / 0.1.1-rc.2 / 0.2.x ……` 并存，可平滑升级、回退、A/B 验证
3. **官方跟随**：仍然不动 DSH 源码，只是换了「谁装它、装哪里、用哪个」

### 关键事实（已实测）

- 内核包 `@deepseek-ai/dsh` 本体 unpacked 仅 ~120KB，但依赖数十个 `@deepseek-ai/*` 子包 + `commander/js-yaml` 等
- 依赖树含**原生模块**（node-pty / sharp / koffi 等），按 **Node ABI** 编译
- ⚠️ **约束**：原生模块不能在 Electron 内置 Node（不同 ABI）下运行 → **必须用系统 Node 或内置官方 Node 运行时**执行 `bin.js`（现有 `resolveNode()` 已走此路径，方案延续）

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    DSH-Exoskeleton 桌面壳                      │
│  ┌──────────────┐   ┌────────────────┐   ┌──────────────┐   │
│  │ DSHManager   │──▶│ KernelManager  │──▶│  内核仓库     │   │
│  │ (启动/健康)   │   │ (托管/路由)     │   │ kernels/     │   │
│  └──────────────┘   └────────────────┘   └──────────────┘   │
│        │                    ▲                                │
│        ▼                    │ 安装/卸载/切换/版本列表          │
│  profile 版本绑定 ◀──────────┴ (IPC: kernels.*)              │
└─────────────────────────────────────────────────────────────┘
        │
        ▼ spawn
┌────────────────────────────────────────────┐
│ 系统 Node（或内置 Node 运行时）               │
│  └─ kernels/<version>/node_modules/@deepseek-ai/dsh/lib/bin.js
│        dsh web --host 127.0.0.1 --port 0 --no-open
│        （DSH_HOME=~/.dsh 不变，数据仍复用）
└────────────────────────────────────────────┘
```

**核心原则**：
- 内核是「数据」不是「程序的一部分」→ 可下载、可删除、可并存、可校验
- `~/.dsh`（DSH Home）始终不变 → 用户数据/会话/插件零迁移
- 系统 dsh 变为「兜底」，托管内核优先

---

## 3. 目录与数据模型

### 3.1 目录布局（userData = %APPDATA%\DSH-Exoskeleton）

```
kernels/
├── v0.1.1-rc.2/                  # 每个版本一个隔离前缀
│   ├── node_modules/             # npm/pnpm 安装的完整依赖树
│   │   └── @deepseek-ai/dsh/lib/bin.js
│   ├── .kernel-meta.json         # 安装元数据（见下）
│   └── <tarball 缓存>            # 校验用 tarball（可删）
├── v0.2.0/
├── v0.2.1/
└── kernels.json                  # 全局登记表（版本索引）
```

### 3.2 元数据模型

```ts
interface KernelMeta {
  version: string              // 语义化版本，如 0.1.1-rc.2
  dir: string                  // kernels/<version>
  status: 'installed' | 'verifying' | 'download-failed' | 'partial'
  installedAt: number
  size: number                 // 字节
  tarballIntegrity: string     // npm dist.integrity（sha512）
  nodeCommand: string | null   // 解析到的 Node 路径（安装时探测缓存）
  source: 'npm' | 'bundle'     // 下载来源
}

interface KernelsIndex {       // kernels.json
  defaultVersion: string | null
  channels: {                 // 可选：跟踪渠道（latest/rc）
    latest: string
    rc: string
  }
  kernels: Record<string, KernelMeta>
}

// 配置新增（AppConfig）
interface AppConfig {
  kernelMode: 'managed' | 'system'   // 托管内核优先 还是 始终用系统 dsh
  defaultKernelVersion: string | null
  // profile 级绑定（与多 Profile 联动，见 §8）
}
```

### 3.3 与现有 DSH_EXECUTABLE / resolveExecutable 的关系

`resolveExecutable()` 的探测顺序调整为：

```
1. profile 指定版本（kernels/<v>/bin.js）     ← 新增（多 Profile 后）
2. config.defaultKernelVersion（托管）         ← 新增
3. kernelMode=managed 时的 defaultVersion       ← 新增
4. DSH_EXECUTABLE（用户显式指定）              ← 已有（保留，优先级最高）
5. npm 全局 / PATH 系统 dsh                     ← 已有（降为兜底）
```

---

## 4. 内核获取与安装流水线

### 4.1 来源：npm registry（权威渠道）

```
GET https://registry.npmjs.org/@deepseek-ai/dsh
  → versions: 所有可用版本列表（新版本检测/版本选择）
  → dist.tarball / dist.integrity（sha512 防篡改）
```

### 4.2 安装步骤（KernelManager.install(version)）

```
1. 校验版本存在性（registry versions 白名单，拒绝任意字符串路径注入）
2. 记录状态 'verifying'
3. 下载 tarball → 校验 sha512（dist.integrity）
4. 解压到 kernels/<v>/（仅包本体）
5. 依赖安装：cd kernels/<v> && pnpm install --prod --ignore-scripts=false
   （或 npm install --omit=dev，二选一，实施时对比体积/耗时）
   ★ 原生模块由 npm/pnpm 自动下载平台预编译产物（sharp/node-pty 均有 prebuild）
6. 写 .kernel-meta.json + 更新 kernels.json
7. 冒烟自检：node bin.js --version 输出与目标一致 → status='installed'
8. 备份联动：安装前 backupManager.autoSnapshot('kernel-install:<v>')
```

### 4.3 内置 pnpm（可离线）

- 方案 A：捆绑 `@pnpm/exe`（官方单文件 exe，~10MB）到 resources/，`pnpm install` 不依赖系统
- 方案 B：捆绑 `npm-cli.js`（Node 自带，保证离线可用）
- 推荐 A（pnpm 快、磁盘友好、workspace 语义与 DSH 官方一致）

### 4.4 Node 运行时策略（ABI 约束决定）

| 方案 | 说明 | 选型 |
| :--- | :--- | :--- |
| 系统 Node（要求已装） | 零额外体积；不满足“无 Node 依赖” | 过渡期 |
| **内置官方 Node 运行时** | 首次自动下载 node-win-x64 zip（~25MB）到 `runtimes/node/`，启动自检、缺失则提示一键下载 | **目标方案**（真零门槛） |
| Electron 内置 Node | ⚠️ ABI 不兼容原生模块（node-pty/sharp），**不可用** | 排除 |

`resolveNode()` 顺序更新：内置运行时 → 系统 node → 报错引导下载。

---

## 5. 运行路由（多版本选择）

```
DSHManager.start():
  version = profile.version ?? config.defaultKernelVersion ?? (kernelMode==='managed' ? kernelsIndex.defaultVersion : null)
  if version: 使用 kernels/<v>/node_modules/@deepseek-ai/dsh/lib/bin.js
  else:       回退系统 dsh（现状行为，完全兼容）
```

- 服务重启时若 defaultVersion 变化 → 自动换内核重启（状态广播）
- 每个内核独立 `node_modules`，**互不污染** → 真正的多版本共存
- `dsh --version` 随当前选中内核如实返回

---

## 6. UI 与交互（设置新增「内核」面板）

```
内核（Kernel）
├─ 当前使用：v0.2.1（托管）  [系统 dsh 兜底中…]    ← 状态徽标
├─ 版本列表（按安装时间倒序）
│    v0.2.1  ● 默认  ● 运行中     4.9MB  2026-08-24  [设为默认] [卸载]
│    v0.1.1-rc.2                   38MB  2026-08-10  [设为默认] [卸载]
├─ 安装新版本：[版本号输入/下拉（来自 registry）]  [安装]   ← 后台下载，进度条
├─ Node 运行时：[内置 v22（已就绪）| 系统 node v24]  [重新检测]
└─ 模式开关：托管内核优先 / 始终使用系统 dsh
```

交互要点：安装/卸载/切换前后自动快照；卸载当前默认版本需二次确认并提示重新指定；非默认版本可安全删除。

---

## 7. 配置持久化

```ts
// AppConfig 增量
kernelMode: 'managed'                    // 默认托管
defaultKernelVersion: '0.2.1' | null
// （多 Profile 之后增加）profiles: [{ id, name, kernelVersion }]
```

迁移兼容：老用户 config 无此字段 → 默认 `managed`，但未安装任何内核时自动回退系统 dsh（**平滑过渡，不破坏现状**）。

---

## 8. 与多 Profile 联动（Phase 4 前置设计）

多 Profile 实现时，每个配置档案可绑定内核版本：

```
profiles/
├── web/      → kernelVersion: 0.2.1
├── tui/      → kernelVersion: 0.1.1-rc.2
```

`dsh --profile <name>` 与 `kernels/<version>/bin.js` 组合使用，实现「不同项目用不同 DSH 版本」。

---

## 9. 安全设计

| 风险 | 对策 |
| :--- | :--- |
| 版本注入/路径穿越 | 版本号必须匹配 `^\d+\.\d+\.\d+([-.][\w.]+)?$` 且存在于 registry 白名单；目录名 = 规范化版本 |
| tarball 篡改 | 下载后校验 `dist.integrity`（sha512），不一致即删除并报错 |
| 原生命令执行 | 不执行用户输入命令；`pnpm install` 仅作用于隔离的 kernel 目录 |
| 卸载误删 | 卸载前保护快照 + 路径必须以 `kernels/` 为根校验 |
| 磁盘空间 | 安装前检查剩余空间（>200MB），安装失败清理残留 |
| 网络中断 | 状态机 `download-failed` 可重试；断点续传（resume）选做 |

---

## 10. 与现有模块集成

- **DSHManager**：`start()` 内核路由 + `resolveNode()` 内置运行时优先；`execDsh` 沿用
- **updater**：新增「内核更新检查」——kernel latest 与托盘「检查更新」合并入口，安装新内核=升级（替代/并行于应用整体升级）
- **backupManager**：内核安装/卸载/切换前自动快照（复用 `autoSnapshot`）
- **plugins**：插件语境 = `~/.dsh/profiles/web`（与内核版本无关，天然兼容多内核）
- **IPC/preload**：新增 `kernels: list/install/uninstall/setDefault/setMode/checkNode`

---

## 11. 风险与边界

- 单内核体积：依赖树 estimate 30–60MB；3 个版本 ~150MB（可接受，磁盘换零门槛；`kernels/` 不入备份默认范围可配）
- 原生模块下载依赖网络（sharp/node-pty prebuild）；失败时 npm 会本地编译，需要 VS Build Tools → 失败即报错引导重试
- 内置 Node 运行时下载 ~25MB；离线用户第一次会卡在运行时就绪 → UI 明示「正在准备运行时」
- Windows/macOS/Linux 平台差异：内核与运行时的平台/架构目录分开（后续跨平台）

---

## 12. 分阶段实施路线

| 阶段 | 内容 | 验收标准 |
| :--- | :--- | :--- |
| **A · 托管内核基础** | KernelManager + npm 下载/校验/安装到 kernels/、内核面板 UI、defaultVersion 路由、构建用系统 node | 卸载系统 dsh 后应用仍能启动 dsh web（零门槛达成） |
| **B · 运行时与升级** | 内置 Node 运行时自动下载/自检；内核新版本检测 + 一键升级/切换；进度推送 | 全新机器（无 Node/npm/dsh）安装应用即可用，纯 GUI 完成内核升级 |
| **C · 生态联动** | profile-version 绑定（配合多 Profile）、多内核 A/B、卸载清理策略、磁盘配额 | 不同 Profile 稳定运行不同内核版本 |

---

## 13. 验收（对文档 §1.2 目标）

- [ ] 全新 Win10/11（仅装应用）→ 首次启动自动装内核 + 运行时 → 打开 DSH Web UI
- [ ] 已有 dsh 用户（本机已有 ~/.dsh 与系统 dsh）→ 无缝接管，数据零迁移
- [ ] 安装 0.1.1-rc.2 与 0.2.1 并存，切换后服务重启即用对应版本
- [ ] 升级失败/新版本异常 → 一键回退旧内核（多版本共存即回滚通道）