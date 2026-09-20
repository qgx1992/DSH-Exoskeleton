# 更新日志（CHANGELOG）

DeepSeek Harness 桌面客户端（DSH-Exoskeleton / dsh-desktop）的版本历史。

- 版本号遵循 SemVer，发布只升 patch（详见 [AGENT.md](AGENT.md) §0 工作约定）。
- 条目按 conventional commit 前缀分组（✨ 新功能 / 🐛 Bug 修复 / ⚡ 性能优化 / 📝 文档 / 🧹 维护）。
- 发布时可先用 `npm run release:notes -- vX.Y.Z --out scripts/out/release-notes.md` 自动生成草稿，再人工润色合并进本文件。

## [未发布]

### ✨ 新功能
- **侧边栏底部改成一行 4 个小按钮（设置 / 网页版 DeepSeek / 管理面板 / 折叠切换）**：官方底部区原本是**两行**——上一行 `footerActions`（插槽 `sidebar.footer.action`，第三方插件与壳注入按钮都落这里）占 69px，下一行官方「设置」整行大按钮（260×42）占 50px，合计 **119px**；现在重排成**一行 4 个 32×32 小图标按钮**，且在整行内**自适应均分**（中心恒为行宽的 1/8·3/8·5/8·7/8，侧栏宽窄变化自动跟随，实机 / 仿真双验证）。实现坚持**只改 CSS 不搬 DOM**（历史教训：搬 slot 节点会与框架重渲染互相触发、渲染进程 100% CPU 卡死），全部用哈希无关的属性选择器（实测官方类名是 hash：`hHd-Xa_footArea`、设置按钮 `VOzbGW_trigger`），宽/窄两态靠壳打在 `footArea` 上的 `data-dsh-exo-rail` 标记区分。
  - **官方「设置」按钮原样保留**，只把盒子从 260×42 缩成 32×32、隐藏文字标签，onClick 仍是官方那个 → **打开 DSH 设置弹窗的行为不变**（测试断言点击仍触发官方节点）；
  - **「折叠全部/展开全部」两个按钮合并成一个双向 toggle**：`dsh-ui-tools` 那行 256×36 工具条 `display:none` 收起，点击时**按现状转发 click 给官方按钮**（用稳定的 `aria-label` 定位，状态取自工作区分组头的 `aria-expanded`；找不到插件按钮则置灰并提示，不静默失效）。为何不自建折叠逻辑：`setAllGroupsExpanded` 在插件内部、依赖 `ctx.slots`/store，壳无法从页面侧调用；
  - **新增「管理面板」入口**：经既有 `__dshExo` 桥回壳 `openPanelTab('overview')`（不扩大 preload 白名单，遵守 R-27）；
  - **窄条（rail）态只留「设置」**：侧边栏收起后宽 56px，排不下 4 个按钮，故 rail 态隐藏三个壳按钮（用户确认口径）；标记属性缺失时官方布局照旧（降级安全）。
  - **踩到的两个坑（已修，均写进测试）**：① 壳的折叠按钮 `aria-label` 与官方插件按钮同名，全局 `querySelector` 会命中壳自己 → 转发变成自点死循环（现限定在 `.wc-collapse-bar` 内查找）；② 第三方插件（实测 dsh-cost-meter）会把自己的元素插到插槽**最前面**且占满整行，因此壳按钮包进 `flex-basis:100%` 的组容器并靠 `order` 固定到最底行（见上条）。
  - **按键行固定在底栏最底部（用户口径）**：壳的 3 个按钮包在**组容器**（`.dsh-exo-foot-group`，`flex:1 1 100%` + `order:1`）里，
    组独占 wrap 的**最后一行** → 无论第三方插件塞多少内容（实测 dsh-cost-meter 的余额/今日/花费 3 行），
    第三方内容都在上方、按键行永远压底；`settingsArea` 同步用 `align-self:flex-end` 下沉到同一底行。
    为何要包一层组：实测第三方插件会把自己元素插到插槽**最前面**且占满整行，不分组时壳按钮会与它混在
    同一 wrap 上下文里、被顶到中间（实测底栏 131px、按键不在底行）；包组后行序由 `order` 控制，
    **不搬动第三方节点**（§7 已知坑 2）。
  - **第三方内容铺满整行（修「左侧空一截」）**：设置列改用**绝对定位**（`left:0; width:25%`）脱离横向流，
    `footerActions` 宽回到 100% → 第三方插件内容从底栏**左边缘**开始铺满（实测修复前 footerActions
    只有 x=76..268、左 64px 空白；修复后 x=12..268 与 footArea 完全对齐）。
    设置列宽取 25% 是因为均分要求其中心在行宽 1/8 处（左边缘贴 0 → 容器宽 25% 时中心恰为 12.5%）。
  - **壳按钮组的均分靠 `padding-left:25%` + `space-around`**：3 项 `space-around` 的自然中心是
    1/6·1/2·5/6，而四个按钮需要 1/8·3/8·5/8·7/8。推导（L 行宽、p 左内边距、W=L-p 内容宽）：
    要求 p + W/6 = 3L/8、p + W/2 = 5L/8 → W = 3L/4、p = L/4 = 25%；验证 L=256 时按钮中心
    96/160/224 = 3/8·5/8·7/8 ✓（与按钮宽度无关，侧栏宽窄变化自动跟随）。
  - 测试：新增 `sidebar-footer` 契约用例（31 项，已接入 `npm test`，含模板字符串 CSS 的语法防线——漏逗号会把两条规则静默合成一条；均分断言覆盖 240/280/320 三种侧栏宽度；「第三方铺满整行 + 在上 + 按键行压底」几何断言），实机端到端 `scripts/probe/verify-sidebar-footer.cjs` **31/31 通过**（真实内核 + 真实第三方插件 + 生产注入脚本 + 宽/窄态截图）。

## [0.9.5] - 2026-09-16

### 🐛 Bug 修复
- **修正通知里的「会话名」取错字段，改为与 DSH 界面一致（重要）**：一个会话的 `session/title` 事件实测会写**多次**——先是**截断的首句提问**（临时），紧跟一个 `session/title-llm-request`（带请求无标题），最后才是 **AI 重命名后的正式会话名**。DSH 界面的口径是内核 `dsh-client-connection` 的 `log.findLast(item => item.type === 'session/title')`（**取最后一条**），而壳侧原先用 `if (!title)` 取**第一条**——于是通知显示的是「重命名前的临时名字」，与侧边栏显示的会话名对不上（实测 **53/60 = 88%** 会话首尾不同）。典型例子：界面显示「修复右键插件」，通知却显示「dsh中安装的dsh-session-context-menu…」。现按内核口径改为取最后一个（`headInfo` 与 `shared/session-jsonl.ts` 的 `extractTitle` 两处同改，后者同步修掉原实现里 `title-llm-request` 分支的同类问题）；修复后实测 **66/66 会话与内核口径完全一致**。因「最后一条才有效」，读取策略也随之下调为「最低扫 2MB、封顶 8MB」（不得一拿到 title 就提前停）。注意这是一个**与下面的「本次提问」独立**的缺陷：即使没有多轮问题，单轮会话的通知标题也会与界面不一致。
  - 测试：新增 `session-jsonl` 4 项（多 title 取最后一个、末条无效时回退前一条有效、跨用户消息取后者）+ `session-watcher` 2 项端到端（正文首行用重命名后的名字 + 负向断言不得出现临时标题），并用**变异测试**验证（改回取第一条 → 2 项立即失败）。

### ✨ 新功能
- **通知正文补上「本次提问」，解决多轮会话通知长得一模一样的问题**：会话名（`session/title`）固定取自**第一句提问**（无此事件时回落首条用户消息），所以一个会话里无论第几轮完成，弹出来的都是同一句话——看得出“哪个会话”，却看不出“刚完成哪一轮”。现正文改为两行：第一行会话名 + 轮次，第二行「本次：<本轮真实提问>」。
  - **难点是「本轮提问」没有现成字段**：`user/message` 事件**不带 turn 编号**，只能按顺序关联——每遇 `turn/start` 切换当前轮，取该轮内第一条 user 消息。但真实日志里一条 `turn/start` 后往往紧跟多条 `role=user` 记录，除第一条外都是**系统注入的伪用户消息**（`Current runtime context…`、`<system-reminder>`、`[genui-action]`、`[model changed`、`The user invoked…`、`background job pwsh-…`），不过滤就会把运行时上下文当成用户问的话。已按实测汇总的前缀白名单过滤；实测 65 个真实会话 / 205 个已完成轮次，**命中率 98%**（未命中的回落为只显示会话标题，不拼空的「本次：」）。
  - 聚合模式（`aggregate`）同理但只取**最后一轮**的提问——合并了多轮却展示首轮提问会让人误以为这几轮问的是同一件事。
  - 原生 toast 正文改为用 `&#10;` 实体换行（字面换行会被 XML 空白规范化折叠成一行）。
  - 测试：新增 `session-watcher` 端到端 6 项（真实提问提取、注入消息必须被过滤、无提问时不得输出空的「本次：」行）+ `notification-hub` 聚合 4 项（取最后一轮而非首轮、无提问不加行）。
- **通知文案调整：项目名从正文移到标题行**：原先通知正文是 `项目「X」· 会话标题（第 N 轮）`，而会话标题本身就是用户的第一句提问，两者叠在一起后正文很快被截断——看不全到底完成了什么。现标题行改为 `项目名 · DSH 对话完成`（询问卡为 `项目名 · DSH 等待你的回答`），正文只留 `会话标题（第 N 轮）`，把可见长度让给真正要看的内容；拿不到项目名（无 cwd）时自动退回基础标题，不留空分隔符。聚合模式（`aggregate`）同步对齐：标题行保留项目名，正文为 `标题（已完成 N 轮）`，顺带消除一处聚合路径上会重复拼项目名的隐患。新增**端到端**断言（非仅辅助函数单测）：在 `session-watcher` / `session-ask` 两个集成用例里直接断言**生产者实际投递载荷**的标题与正文（含「正文不再含 `项目「` 前缀」的负向断言），防止文案在 producer 侧被改回。

## [0.9.4] - 2026-09-16

### 🐛 Bug 修复
- **会话完成通知整体失效（内核 Session format 升到 v3 后，壳侧仍在按旧文件名读日志）**：DSH 内核 0.1.5 起把会话日志从 `session.jsonl.zstd` 改为**代际化命名** `session.v3.jsonl.zstd`（格式每迁移一版就新写一个 `session.vN.jsonl`，旧文件保留不删），而 `session-watcher.ts` / `sessions.ts` 里把文件名写成了字面量。于是 `stat` 恒失败 → 会话完成 / 询问卡等待通知**全部静默丢失**，且会话面板看不见升级后的会话（实测本机 90 个会话里只有 40 个（旧名，含 14 个 v0/v3 并存）能被列出，**50 个 v3 独有会话完全不可见**；通知侧更彻底，v3 会话从未进入跟踪表）。修法：新增 `resolveSessionLog()`（`shared/session-jsonl.ts`）作为唯一定位入口，镜像内核 `dsh-session-format` 的代际规则（`generation 0 → session.jsonl`、`N ≥ 1 → session.vN.jsonl`，再叠 `.zstd` 压缩后缀），并**按内核口径取最高代数**——v0/v3 并存时必须读 v3，否则读到的是迁移前的陈旧内容。读写两端（列表/计数/查找/导出/定位 + 通知监测）全部改走该入口，不再拼字面量。顺带处理两处边界：日志换世代时**重建基线**（新旧文件偏移无对应关系，否则会错位解析出一批误报）、遇到明文 `.jsonl`（非 zstd，本壳无法解压）跳过并告警，避免每轮扫描空转。诊断探针里「取最新会话文件」的旧名过滤器同步放宽（否则会挑到陈旧 v0 文件、给出误导性结论）。新增验证：`session-jsonl` 用例 17 项（命名解析/择优：前导零、大写 `.V3`、`session.v0` 均判为非规范名；`v10 > v3`）、`session-watcher` 3 项与 `session-ask` 2 项集成断言（**默认改用 v3 命名**跑全部既有语义，并分别覆盖「旧命名仍兼容」与「v0/v3 并存取 v3」）。
- **`npm run clean:dist` 从不清理 beta 产物，导致 `dist/` 只增不减**：清理脚本的文件名正则只认 `x.y.z` 直跟 `.exe`，而 beta 产物是 `0.9.4-beta.4.exe`，后缀匹配不上 → 被归入「非版本化文件」永久保留（实测累积到 1.4GB 才被发现）。现按「**正式版 / 预发布版**」两条通道分别计数：正式版默认保留最近 5 个，预发布版默认保留最近 2 个（`--keep N` / `--keep-beta N` 可调）——beta 用完即弃，不宜与正式版争名额；且正式包已发到 GitHub Release，本地 `dist/` 只服务于「回滚/对照最近几版」的临时需求，无需长期存档。同时修正版本排序：旧实现只解析 `x.y.z` 数字段；新版带预发布后缀逐段比较（`beta.10` 排在 `beta.2` 之后，绝不比字符串，遵守 R-22），且正式版高于同 base 预发布版。新增单测 `scripts/test/test-prune-dist.mjs`（20 项，已接入 `npm test`）：这是**会删文件**的脚本，正则/比较器写错会静默删错东西，故重点覆盖 beta.10 排序、两通道互不挤占、孤儿 blockmap 纳管、`latest.yml`/`win-unpacked` 绝不误判为产物，并用断言锁住默认保留数量（5 / 2）防文档漂移。
- **中间主体顶部拖不动窗口（只有左侧边栏顶部能拖）**：无标题栏后窗口只能靠页面里的拖拽区拖动，而 `-webkit-app-region` **不继承**（初始值 `none`），必须逐块声明——旧实现只声明了 DSH 侧边栏的 `logoRow` 一处，中间主体顶部从未被声明，就是普通网页内容（实测 y=18 横向扫描：x=60–260 命中 `logoRow` 解析为 `drag`，x=300–1380 命中 `header`/`scrollBody` 解析为 `none`）。现按两种状态分别补齐：**会话态**给 `header` 设 `drag`（§4.1.2.2 的 `padding-top:36px` 让位规则使该带恰好是 header 的**空内边距**，设 drag 不会压住任何内容），并把行内 `button/a/input/select/textarea/svg/img/[role]` 逐个回设 `no-drag`（实测 header 内 15 个可交互元素全部保持可点，防误拖）；**空态**由 `buildTopDragStripScript` 插入一条固定定位透明条 `#dsh-exo-drag-strip`（DSH 空态根本不渲染有高度的 header，实测该带内可交互元素为 **0 个**，可安全整条设 drag）。拖拽条三条约束：仅空态插入（会话态留着会压住标题行面包屑等 3 个按钮，实测）、左边界实时跟随侧边栏（折叠 280↔56px）、右边界让开原生按钮簇 138px。折叠只改布局宽度不改 class 也不增删节点，故除内容变更观察器外另接 `ResizeObserver` + `window.resize`，壳侧 `syncDragStrip()` 在窗口 resize 时再推一次。
- **会话头部与右上角原生窗口按钮重叠，右上角那排图标按钮被最小化/最大化盖住**：Windows 下原生按钮簇占据右上角 `x ∈ [W-138, W], y ∈ [0, 36]`，系统画在内容**之上**；而 DSH 会话头部 `<header>` 位于 `y = 0..86`、其 `titleRow` 在 `y = 10..42`，实测**每个窗口宽度下都重叠 110×26 = 2860px²**，`headerUtilities`（124×28）约 62% 被压、`headerCorner`（28×28）约 86% 被压。根因是 `env(titlebar-area-*)` 在本应用的 WebContentsView 子视图里实测全为 `-1px`（Electron 未下发 WCO 变量），DSH 自己无从避让，只能由壳处理。修法：给 `header` 加等于叠加层高度的 `padding-top`，整行（标题 + 选项卡）下移到按钮带下方。锚点用 `<header>` **语义标签**而非 CSS module 类名（实测类名是 hash `wSkVaW_header` 不可依赖；`<header>` 全页只命中 1 个且正是目标，同一探针已验证）；只加 padding 不改高度/外边距，header 作为 grid 行会自然把后续内容下推，无叠层错位。
- **右上角三个原生窗口按钮底下压着一块对不上的颜色（暗色下一条色缝、亮色下白底压黑块）**：`titleBarOverlay.color` 是**窗口级**的，旧实现把它硬编码成 `#0b0f17` 就再也不变，而窗口内容区依次承载底色互不相同的表面——壳管理面板 `#060B12`、DSH Web UI 顶栏 暗 `#151517` / 亮 `#FFFFFF`、官方网页版站点自定。实测（桌面级截屏取样）旧值在 DSH 顶栏上形成一条横贯的色缝，边界正好落在离右边缘 137px 处（即三个按钮底下那块矩形），`ΔRGB=10`；切到 DSH 亮色主题后恶化为「白底压黑块」`ΔRGB=237`。现在改为**按当前在上的表面 + 该页面当前主题动态同步**：新模块 `src/main/titlebar-overlay.ts` 在页面 overlay 带内多点采样、沿祖先链穿透半透明层取「实际被画出来的」底色（拿不到时回退官方令牌 `--dsw-alias-bg-base` → `body` 背景 → 主题兜底常量），并据此下发 `setTitleBarOverlay`；按钮笔画色按底色亮度在深浅两候选间取对比度更高者（实测暗 17.45 / 亮 18.90，均远超 WCAG AA 4.5）。DSH 换主题只改 `body[data-ds-dark-theme]`、不发事件，故注入 MutationObserver 经既有 `__dshExo` 白名单通道回壳跟随（不扩大 preload 暴露面，遵守 R-27）。顺带修正 `--color-canvas` 同值问题：壳画布色收敛为 `SHELL_CANVAS_COLOR = #060B12`，与 renderer 的 `--color-canvas` 严格同值（新增测试断言二者一致，防止改一处漏一处）。

### ✨ 新功能
- **网页版 DeepSeek 入口移入 DSH Web UI 自己的左侧边栏**（底部「设置」行上方）：点一下就在侧边栏右侧嵌入官方 chat.deepseek.com，再点收起。实现走 **DOM 注入**——往官方插槽已渲染出的锚点 `[data-slot="sidebar.footer.action"]` 插一个按钮（该标记不带 hash、跨版本稳定；CSS module 类名是 hash 不可依赖），点击经既有 webview 桥 `window.__dshExo` 回壳切视图。按钮带 MutationObserver 自愈（React 重渲染被清掉后自动补插）、幂等、选中态由壳回写。**为何不用官方插槽注册**：`sidebar.*` 插槽是 cordis 客户端插件的注册面，需要独立插件包（本仓 `plugins/` 已 gitignore，插件源码在各自仓库），而壳要开箱即用。**为何不用 iframe**：官方响应头实测 `Content-Security-Policy: frame-ancestors none`，仍用独立 WebContentsView（顶级浏览上下文，登录态存 `persist:deepseek-web` 重启保留）。
- **去掉标题栏（含系统原生）与默认菜单**：窗口改为 `titleBarStyle: 'hidden'` + `titleBarOverlay` —— 内容从 y=0 起、右上角叠系统原生最小/最大/关闭按钮，顶部那一行直接是 DSH 自己的侧边栏品牌行（鲸鱼 logo + deepseek HARNESS），与参考设计一致。同时 `Menu.setApplicationMenu(null)` 移除 Electron 默认应用菜单（File / Edit / View / Window / Help）——实测该菜单只在带 frame 的窗口才被画出（窗口高-内容高 39px），不清理就会与「无标题栏」冲突。窗口拖动由注入 CSS 给 DSH 顶部 logo 行设 `-webkit-app-region: drag`（行内按钮回设 `no-drag`，保证 logo 的「新建会话」点击不被吞）。
- **窗口改为「无标题栏 + 右上角原生窗口按钮」**：`titleBarStyle: 'hidden'` + `titleBarOverlay`，内容从 y=0 铺满；不再自绘标题栏，也不再使用系统完整标题栏。
- **管理面板改从系统托盘进入**：托盘右键菜单新增「管理面板…」，打开即定位到总览页；面板内底部保留「回到 Web UI」。

### 🧹 维护
- 管理面板移除「网页版」导航标签（入口已改由 DSH 侧边栏承载），`DashboardTab` 同步去掉 `'web'`；移除面板内网页版视图与 `setWebPanelVisible` 的渲染层调用。
- 删除 `src/renderer/components/TitleBar.tsx` 与 `.titlebar-drag/.titlebar-no-drag` 样式；下线已无引用的窗口控制 IPC（`window:minimize/toggleMaximize/close/isMaximized`、`window:maximizeChange`）。
- 新增 `src/main/web-sidebar-entry.ts`（侧边栏入口注入 + 顶部拖拽区 CSS）与验证脚本 `scripts/probe/verify-web-sidebar-entry.cjs`（6 项）、`scripts/probe/verify-shell-top.cjs`（5 项）、`scripts/probe/probe-overlay-buttons-shot.cjs`（窗口按钮桌面级截屏取证）。
- 新增 `src/main/titlebar-overlay.ts`（原生窗口按钮叠加层底色同步：颜色归一化 / 对比度选笔画色 / 顶栏取色探针 / 主题观察），配套单测 `scripts/test/test-titlebar-overlay.cjs`（30 项，已接入 `npm test`）与端到端取证 `scripts/probe/probe-overlay-color.cjs`、`scripts/probe/verify-titlebar-overlay.cjs`（9 项，**桌面级像素**比对 + 旧值对照实验）。
- 会话头部让位规则并入 `src/main/web-sidebar-entry.ts` 的 `buildTopDragRegionCss`（与拖拽区同一次 insertCSS 下发）；新增取证与验证脚本 `scripts/probe/probe-overlap-widths.cjs`（逐宽度重叠取证）、`scripts/probe/probe-header-selector.cjs`（锚点稳定性勘察，供内核升版时复核选择器）、`scripts/probe/verify-header-offset.cjs`（22 项，含「会话头必须已渲染」的非空过门禁与修复前基线对照）。
- 顶部拖拽区补齐中间主体：`buildTopDragRegionCss` 增加 `header { app-region: drag }` 与行内 `no-drag` 回设，新增 `buildTopDragStripScript`（空态拖拽条）与 `WINDOW_CONTROLS_CLUSTER_WIDTH`/`DRAG_STRIP_ID` 常量、`windowManager.syncDragStrip()`；配套取证脚本 `scripts/probe/probe-drag-region-dom.cjs`（顶部带元素与 `app-region` 解析勘察）与验证脚本 `scripts/probe/verify-drag-region.cjs`（22 项，含空过门禁与折叠跟随）。

## [0.9.3] - 2026-09-11

### 🐛 Bug 修复
- **内核「卸载不了」——报 `EPERM ... unlink libvips-42.dll`**：根因是 Windows 文件占用（不是权限）。sharp / koffi 等原生模块在多个内核版本之间是 pnpm 硬链接共享的**同一个文件对象**，而正在运行的内核进程会把这些 DLL 映射进内存，被映射的原生模块 Windows 拒绝删除。旧实现直接 `fs.rmSync(recursive, force)`，撞上第一个删不掉的文件就抛错中断、不重试不回滚——目录被删掉一半（连 `bin.js` 都没了，内核实际已损坏），而 `kernels.json` 仍写着「已安装」，用户只能反复点卸载、每次再破坏一次。现在改为**改名优先、删除兜底**：先把目录改名成 `<版本>.deleting`（实测文件被映射时改名依然可行，只有删文件被拒）→ 立即清掉索引项、界面即时生效 → 物理删除交给后台重试，仍删不掉就留到下次启动回收。卸载动作因此与可能失败的删除解耦，不再出现「删一半」。
- **卸载 / 安装中断后索引与磁盘长期不一致**：新增启动对账——`bin.js` 已丢失的内核标记为「已损坏」（不再冒充可用内核）、目录已不存在的索引项直接清除、指向已损坏内核的默认内核指针与崩溃回滚指针一并清空（否则会出现「默认内核指向一个跑不起来的版本」且因引用保护无法卸载的死锁）。
- **安装被中断的内核残留完全看不见却一直占盘**：这类条目状态停在「安装中」，既不出现在「已安装」列表里、又占着磁盘（实测泄漏 252MB）。现在会归类为「已损坏」显示在列表末尾，并提供「清理」入口。
- **占用类报错看不懂**：`EPERM` / `EBUSY` 现在翻译成中文并给出可操作建议（「文件正被占用，请先停止服务后重试」），不再直接抛出系统错误码。
- **配额数字与磁盘不符**：内核占用按磁盘实测统计，并单列「待回收」（卸载已生效但文件仍被占用、等下次启动回收的占用），不再出现「卸载了但空间没降」的困惑。

### ⚡ 性能优化
- **启动对账不再冻结启动**：最初的对账实现会同步全量扫描损坏内核目录来重测占用，实测 150MB / 1.7 万文件需 3.6s，两个残骸就会卡住启动约 7s。现改为后台异步重测；回收站占用同样改为「只回缓存 + 后台补测」，不在面板同步路径扫描大目录（实测对账返回 8ms，对照同步扫描 711ms）。

### 📝 文档
- README（中 / 英）新增「最新版本要点（v0.9.3）」小节，同步补充内核管理「卸载可靠性 + 启动对账」能力描述；并修正一处过期事实：首启预置内核写的是 `0.1.2-alpha.5`，实际自 `e24e6ed` 起已是 `0.1.5-rc.1`。

### 🧹 维护
- **内核面板**：损坏内核显示「已损坏」徽标并提供「清理」按钮（不再提供「设为默认 / 检测」），可用内核与损坏内核分先后排序；总览「已装内核」不再把损坏项计入。

## [0.9.2] - 2026-09-10

### ✨ 新功能
- **日志页新增「清除日志」**：一次清掉日志文件与 `.1` 轮转备份并清空面板内容；先关流再删文件（Windows 下更稳），清空期间新产生的日志既不丢文件也不丢视图。
- **应用内确认弹窗**：新增 `ui/Modal` + `useConfirm` 原语（Esc/遮罩关闭、焦点锁定与归还、危险操作默认聚焦「取消」），面板里 11 处系统 `window.confirm` 全部替换；内核「模式」切换、档案「激活」此前会直接重启服务却没有确认，一并补上。
- **通知聚合模式可选**：设置页「会话完成通知」由开关改为三选（关闭 / 每轮 / 聚合），「通知聚合窗口」随模式联动（非聚合模式置灰）。此前 `aggregate` 聚合通道在主进程已实现，但界面上不可达——手工写进配置的用户一拨开关就会被静默降级成「每轮」。
- **内核推荐/升级统一为 rc 通道**：「安装新版本」的「（推荐）」与「内核新版本可用 / 一键升级」只取 rc 正式发布通道的最新版，alpha/next 预览版不再推荐；首启预置内核同步改为 `0.1.5-rc.1`。
- **插件页全局忙锁**：任一插件操作（含一键安装全部）进行中时，其余安装/升级/卸载/检查更新一律禁用，避免并发 `dsh plugin` 重写同一份依赖树。
- **表单原语统一**：`Input` 增加 `mono`（数据等宽 / 文本非等宽）与 `wrapperClassName`，新增 `SearchInput`；7 处散落的裸 `<input>` 迁移到原语。

### 🐛 Bug 修复
- **DSH Home 输入框画出卡片边框**：原实现把宽度写在 `className`（作用于内部 `<input>`）上，而 flex 行里被压缩的是外层容器——容器缩到 231px 时内部 `input` 仍固定 288px，于是横向溢出。现在宽度类一律作用于容器、内部 `input` 为 `w-full`，任何窗口宽度下都不再溢出。
- **便携版被当成安装版走自动更新**：只判 `app.isPackaged`（便携版同样为 true），缺少 `PORTABLE_EXECUTABLE_DIR` 检测 → 会调 electron-updater 的 `quitAndInstall`（上游不支持 portable 目标），而界面文案却承诺「便携版提供下载页引导」。现在便携版与开发版一样走下载页分支。
- **beta 版收不到回正式版的升级提示**：版本比较只取 `x.y.z` 数字段，`0.9.2-beta.1` 与 `0.9.2` 被判为相等。改用与内核同一套 `compareVersions`，支持 `-beta.` / `-rc.` 后缀。
- **总览「会话」数字错误**：用 `list(6).length` 当总数（永远显示 ≤ 6）。新增 `sessions:count`（只扫目录、不做 zstd 解压，且不受 `MAX_LIST` 截断）取真实总数。
- **总览未检测更新却显示「全部最新」**：改为「未检查更新」，不再给出没有依据的结论。
- **日志告警误报**：清理过期 `dsh-auth` cookie（保留最近 2 个，防请求头超 16KB 触发 431）与主动停止服务导致的进程退出都被记成 WARN，使总览「日志告警」每次重启都刷出假告警。两者改为 INFO，只有非预期退出才 WARN。
- **设置页非法输入静默回滚**：端口 / 聚合窗口 / 内核配额输入非法值时直接还原且无任何提示，现在给出字段级错误；DSH Home 增加绝对路径校验与「修改后需重启服务生效」提示。

### 🧹 维护
- `DESIGN.md` 增补 `## Variants`：`Modal` + `useConfirm` 弹层原语、`danger-solid` 按钮变体、`Input.mono` / `Input.wrapperClassName` / `SearchInput`，明确弹层与表单不再逐页自绘。

## [0.9.1] - 2026-09-07

### 🐛 Bug 修复
- **插件升级失败（exit 1）**：`dsh plugin add` 重装依赖树时执行 node-pty 等原生模块的 install 脚本，脚本按 PATH 找裸 `node` 失败（桌面端用内置 Node 运行时直接启动 dsh，该目录不在 PATH）→ `ERR_PNPM_EXECUTOR_LIFECYCLE_SCRIPT_FAILED`。现在把内置 Node 运行时目录注入 `dsh plugin` 子进程 PATH（与 pnpm 注入同源），升级不再被原生依赖卡住。
- **GitHub 源插件装不上（exit 1）**：pnpm 解析 `github:owner/repo` 依赖裸调 `git ls-remote`，桌面端子进程 PATH 缺 git → `ERR_PNPM_GIT_RESOLVE_FAILED: git executable not found on PATH`。现在注入 git bin 目录（`where git` 探测 + 常见路径兑底）。
- **卸载插件后服务起不来**：`dsh plugin remove` 重写 `dsh.profile.bundles` 时可能把官方基础 bundle（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）挤掉（不在 profile dependencies 中），基础 services 层（tools/web/webServer/sessions 等）缺失 → 所有插件 pending → `plugin tree failed to load` → 崩溃重启循环。现在安装/卸载/升级后 `ensureBaseBundles` 兑底补回，幂等。
- **GitHub 源推荐插件「已安装」判断**：推荐条目的已安装判断兼容 `installTarget` 匹配，避免 name 与 deps key 不一致时已装插件仍显示「安装」。

### ✨ 新功能
- **推荐插件调整**：移除 `@wenbin_wb/dsh-bridge`，新增 `dsh-pocket`（手机扫码同步访问 DSH）。

## [0.9.0] - 2026-09-06

### 🐛 Bug 修复
- **托盘「打开内核面板」打不开面板**：托盘「发现更新」对话框里的「打开内核面板」之前只改了主进程的面板显隐，渲染层状态未同步，服务运行中会显示空白区域。现在新增 `panel:open` 主进程 → 渲染层同步通道（`DashboardTab` 统一类型 + preload `onOpenPanel`），点击后唤起窗口、打开管理面板并直接定位到「内核」标签。
- **zstd worker 同步阻塞主进程**：系统 Node 探测由 `execFileSync` 改为异步 `execFile`（含并发启动防护），避免首次会话扫描时卡住主进程最多 6 秒；`close()` 时立即结算所有 pending 请求，不再空等 15 秒超时。
- **子进程超时可能永久挂起**：内核依赖安装与 `dsh` 子命令超时后立即结算 Promise（返回 `-1` 超时错误），不再依赖 `taskkill` 后的 `close` 事件，避免失败进程不退出时面板操作一直转圈。

## [0.8.9] - 2026-09-06

### 🐛 Bug 修复
- **插件安装失败（exit 1）根治**：`dsh plugin` 内部裸调 `pnpm`，缺少 pnpm 的环境（零门槛装机）下所有插件安装/卸载/升级都失败。桌面端现在自愈：用嵌入式 Node 运行时的 npm 把 pnpm 预置到 `userData/pnpm` 隔离前缀（一次性联网，之后离线可用，复用内核镜像源配置），并注入 `dsh plugin` 子进程 PATH。
- **「装完成功但提示安装失败（exit 1）」**：pnpm 10+/12 默认拦截依赖 build script（`ERR_PNPM_IGNORED_BUILDS`），pnpm 以 exit 1 收尾、依赖其实已写入。现在按成功处理（与内核安装 `isIgnoredBuilds` 同语义），并把被拦包自动写入 profile `pnpm-workspace.yaml` 的 `allowBuilds` 白名单（含 pnpm 自写的占位值）后重试一次，让构建脚本真正执行、dsh 正常完成 bundle reconcile。
- **市场页「未声明 dsh.bundle，不会进入 profile bundle 层」**：IGNORED_BUILDS 使 `dsh plugin add` 中断了 bundle 注册，已装插件不在 `dsh.profile.bundles` 里。现在安装/升级后自动补注册（仅针对声明 `dsh.bundle` 的插件），并新增 `reconcileInstalledBundles()` 在服务就绪时修复历史欠账；卸载时清理悬空 bundle 条目。

### 🧹 维护
- 环境依赖提示：GitHub 来源插件（`github:owner/repo`）需要本机安装 Git（pnpm 用 git 解析仓库），npm 来源插件不受影响。

## [0.8.8] - 2026-09-04

### ✨ 新功能
- **网页版 DeepSeek（官方 chat.deepseek.com）面板**：标题栏右上角「网页版」按钮（地球图标，位于「打开管理面板」左侧，激活态高亮）一键直达官方网页版，再点关闭；管理面板按钮固定落在「总览」。承载方式：独立 WebContentsView 加载 chat.deepseek.com（登录态存独立持久化分区 persist:deepseek-web，重启保留）。**为何不用 iframe**：官方响应头实测 `Content-Security-Policy: frame-ancestors none`，任何 iframe 嵌入都会被拦截；独立 WebContentsView 是顶级浏览上下文，不受该 CSP 限制（等价浏览器新标签）。站内新窗口在视图内导航，外链交给系统浏览器。

## [0.8.7] - 2026-09-02

### 🧹 维护
- **首启默认内核升级至 0.1.2-alpha.5**：全新安装预置内核从 0.1.2-alpha.4 提升到 alpha.5（本机试启动门禁无补丁通过 + 会话解析回归通过，含 alpha.5 运行时读写 alpha.4 时代会话文件的严口径验证；见 `scripts/probe/probe-newkernel-compat.cjs`——已支持传入版本号参数——与 `scripts/probe/probe-alpha4-sessions.cjs`）。
- **兼容补丁注册表注释**：补记 alpha.5 无需补丁。

### ✅ 已修复（随内核升级）
- **消除 v0.8.6「会话标题过渡」已知行为**：官方 alpha.5 实现投影缓存跨版本读兼容（`compatibleVersions: [3,4]` + lineage 字段转 optional + `backup-and-skip` 兜底 + bootstrap 投毒修复），升级到 alpha.5 后旧会话标题在侧边栏立即可服务，无需逐个打开恢复。

## [0.8.6] - 2026-09-02

### 🧹 维护
- **测试链重构**：`npm test` 由 package.json 内 20+ 段 `&&` 串跑改为 `scripts/run-tests.mjs`（用例表声明式，失败报「用例名+阶段+退出码」，支持 `npm test -- <子串>` 单跑）；无全局 dsh 种子的环境 test-kernel 明确走跳过分支不再计失败；kernel-provision 不再断言具体默认内核版本号（防每次升内核腐烂）。
- **scripts/ 目录分层**：CI 常驻冒烟测试移入 `scripts/test/`，一次性实机探针/勘察脚本移入 `scripts/probe/`（git rename 保留历史），内部相对路径与全部文档引用连带修正；`zstd-worker.cjs`（打包资产）与构建脚本留根目录。
- **dist/ 清理策略**：新增 `scripts/prune-dist.mjs`（`npm run clean:dist`）——按 semver 只保留最近 10 个版本的 Setup/Portable/blockmap，孤儿 blockmap 一并纳管，`--dry-run` 预览；非版本化产物（win-unpacked、latest.yml）不动。
- **文档纠偏**：AGENT.md 基线描述更新为 main/v0.8.x（原 test/own-plugins 线已并入删除）；README 中英首启预置内核版本 `0.1.2-alpha.1` → `0.1.2-alpha.4`（与 kernel-defaults.ts 同步）。
- **首启默认内核升级至 0.1.2-alpha.4**：全新安装预置内核从 0.1.2-alpha.1 提升到已实测免补丁的 alpha.4（试启动门禁 + 会话解析回归通过，见 `scripts/probe/probe-newkernel-compat.cjs` / `scripts/probe/probe-alpha4-sessions.cjs`）。
- **兼容补丁注册表注释**：明确 alpha.3 / alpha.4 无需补丁、勿添加空条目。

### 📝 已知行为
- **内核升级到 0.1.2-alpha.4 后的会话标题过渡**：官方投影缓存存储域 v4→v5（身份校验加入 `isSeeded`/`inheritedEventCount`），升级后旧会话在侧边栏暂显示为工作区名，**逐个打开一次即永久恢复**（数据无损，日志内 `session/title` 事件完好）。

## [0.8.5] - 2026-09-01

### ✨ 新功能
- **询问卡等待通知（session-ask）**：Agent 提问（`ask_user_question`）或计划审批（`exit_plan_mode`）阻塞等待用户输入时发送 Windows 通知（标题、问题文本、轮次），点击跳回提问会话；用户回答后自动从操作中心撤销残留 toast。检测原理：`user-questions/request` 是仅实时推送的 waterfall 事件、不落会话日志，改用持久化影子信号——`tool/call`（白名单工具）入日志而同 `callId` 的 `tool/result` 未出现即卡片等待中（`zstd-worker` 增量解析 + `session-watcher` pending 状态机，已用真实会话数据验证 38/38 全配对）。设置面板新增「询问卡等待通知」开关（默认开）；非白名单工具的慢执行不误报；`turn/end(interrupted/aborted)` 与秒答（call+result 同批）均已处理。
- 新增测试：`test-ask-detect.cjs`（合成多帧 zstd 会话验证检测状态机 9 场景）。

## [0.8.4] - 2026-09-01

> 补录：v0.8.4 发布时 CHANGELOG 漏记，内容按 Release 说明回填。

### ✨ 新功能
- **内核面板「检测」按钮**：每个内核行可单独试启动检测（与「设为默认」门禁同路径），不切换默认，结果就地显示并写入启动健康状态。
- **插件「加入推荐」**：已安装行可一键把插件加入「推荐插件」列表（自定义推荐持久化，支持「移出推荐」）；推荐区可装回同一来源。
- **「已停用」徽标**：被当前内核兼容补丁停用的插件在已安装列表显式标注，悬停说明原因与恢复条件。
- **行内结果提示（RowNotice）**：检测 / 设为默认 / 卸载 / 升级 / 安装等操作结果就地跟随触发它的那一行。

### 🐛 Bug 修复
- **内核更新检测按发布通道取真实最新版**：综合 npm `dist-tags` 全部通道（latest/next/alpha/rc）取最大版本，UI 标注版本来源「通道」；修复 latest 停在旧稳定版导致的误报/漏报。
- 一键升级提示位置就地跟随升级卡片；「设为默认」增加确认提醒。

## [0.8.3] - 2026-08-31

### ✨ 新功能
- **内核兼容层（R-24）**：托管 alpha 内核带病（如 alpha.2 移除旧 settings API 导出）时自动注入官方 `--patch` 叠层兼容启动，不写用户 profile、不改内核；切换默认/绑定内核前**试启动门禁**（克隆 DSH_HOME 实际拉起 + 健康检查），失败拦截并保留当前版本；崩溃自动回滚 + bootHealth 持久化。
- 管理面板新增「支持作者」打赏入口（TipDialog）。
- 首次引导文档（docs/onboarding）。

### 🐛 Bug 修复
- **预设切换报 `tool "pwsh" is already registered`（版本混杂根治）**：内核升级/切换后，profile 私有第一锚点 `~/.dsh/profiles/web/node_modules/@deepseek-ai` 的官方包链接统一重建指向当前托管内核（`relinkProfileAnchor`，幂等、只处理 symlink/junction）；此前残留指向 npm 全局或旧内核的链接会让同一进程出现双模块实例（scope Symbol 分裂），预设工具注册进 root 表撞名。触发点：内核安装成功后 + 每次服务启动前（覆盖切默认/切档案/重启全部路径）。
- **服务停止残留进程**：`stop()` 改为等待 taskkill 进程树清理完成再返回，重启/切换内核时不再残留旧孙进程与端口。
- **内嵌 Web UI 加载失败（431）自愈**：attach 时清理累积的 `dsh-auth-*` cookie（保留最近 2 个，修复多次重启累积超 node:http 16KB 请求头上限导致的 431）+ 清缓存 + 检测「Failed to load plugins」自动绕缓存重载（最多 30 次）。

### 🧹 维护
- 新增测试：`test-kernel-compat.cjs`（兼容层）、`test-relink-anchor.cjs`（第一锚点重链接 + 幂等）。
- AGENT.md §7 新增「版本混杂 + relink 根治」「野目录」踩坑记录。

## [0.8.2] - 2026-08-30

### 🐛 Bug 修复
- 通知点击不置顶：`windowManager.show()` 的 Windows 前台锁对策改为「先置顶 → 聚焦 → 250ms 后撤销」（旧实现 `setTimeout(0)` 置顶/撤销被合并成 no-op，实测失效），点击通知/协议激活后窗口稳定抬到最前。
- 操作中心（通知栏）残留通知点击无效且不消失：根因是 Electron 34 的 Windows toast 没有可用的激活机制（[electron/electron#32585](https://github.com/electron/electron/issues/32585)）——toast 进入操作中心后再点击不产生事件、也不会被系统移除。改为自定义 `toastXml` 协议激活（`activationType="protocol"` + `launch="dsh-exo://notify?…"`），点击（弹出/操作中心/冷启动）统一拉起 `dsh-exo://` 协议 → 单实例 `second-instance`/argv 转发 → 精确回放原点击动作并 `close()` 移除；Windows 在协议激活成功后自动从操作中心移除该 toast。
- 通知去重：协议 toast 不再挂实例 `click`（实测一次真实点击会同时触发实例 click 与协议启动，避免会话被激活两次）；已投递通知注册表带上限 + 1h 过期清扫，防内存增长。

## [0.8.1] - 2026-08-29

### ✨ 新功能
- 管理面板 UI 整体改版为「黑金仪表台」视觉风格（标题栏 / 总览 / 状态页）。

## [0.8.0] - 2026-08-29

### ✨ 新功能
- 首启默认内核预置（内核管理阶段 D）：全新安装首次启动自动安装并启用默认内核（`0.1.2-alpha.1`），开箱即用。

### 🧹 维护
- `dsh-ui-tools` 移出默认启用，改为推荐列表普通条目（按需手动安装）。

## [0.7.9] - 2026-08-29

### ✨ 新功能
- 管理面板 P0：新增总览首页 + 会话管理，设置面板补全。

### 📝 文档
- DEV_DOC 补充 AI 协作与文档职责说明。

### 🧹 维护
- 移除设置页 Agent 工作区（工作区交由 DSH 侧边栏管理）。
- dev 支持 `DSH_DEV_USER_DATA` 并行实例（独立 userData 避开单实例锁）。

## [0.7.8] - 2026-08-28

### ✨ 新功能
- 壳侧会话感知通知：仅后台会话完成时弹通知，聚焦当前活动会话完成不打扰。
- 会话检测改为 fs.watch 事件驱动 + 500ms 兜底轮询（近零延迟）。

## [0.7.7] - 2026-08-28

### 🐛 Bug 修复
- 修复点击 Windows 原生通知后桌面端不自动置顶的问题（前台锁对策）。

### 🧹 维护
- 自研插件 `dsh-notify` 源码移出本仓库，独立到 [qgx1992/dsh-notify](https://github.com/qgx1992/dsh-notify)。

## [0.7.6] - 2026-08-28

### ✨ 新功能
- 通知 auto 路由改为焦点感知：DSH 窗口不在前台焦点时走原生通知。

## [0.7.5] - 2026-08-28

### ✨ 新功能
- 通知 auto 路由加入窗口可见性判断：窗口隐藏 / 最小化时走原生通知（防漏看）。

## [0.7.4] - 2026-08-28

### ✨ 新功能
- 通知功能插件化：notification-hub 事件中枢 + webview 桥 + `dsh-notify` 插件。

### 🐛 Bug 修复
- 修复「点击通知偶尔不跳转」（webview 握手被覆盖 + 原生点击统一走 `sessions.open`）。

### 📝 文档
- 新增英文版 README（`README.en.md`），标题下加中英文切换链接。

### 🧹 维护
- 新增 release-notes 脚本，发布流程自动按提交生成中文更新日志。

## [0.7.3] - 2026-08-28

### 🐛 Bug 修复
- 修复插件升级对已存在的同级范围依赖不生效（`pnpm add` 裸包名 / `@latest` 均 no-op）。

## [0.7.2] - 2026-08-28

### ✨ 新功能
- 插件页支持检查更新 / 一键升级（npm + GitHub 来源）。
- 备份支持任选恢复项目。

### 📝 文档
- DEV_DOC 补充推荐插件集 / 默认启用预置 / 已知问题（pnpm 供应链策略）。

### 🧹 维护
- `.gitignore` 忽略 AGENT.md 与会话安装插件的临时产物。

## [0.7.1] - 2026-08-27

### ✨ 新功能
- 推荐列表以 `dsh-ui-tools`（修复版）取代 `dsh-model-select-style` 与 `dsh-workspace-collapse`，并默认启用（新装自动安装注册 bundles）。

### 🧹 维护
- `dsh-workspace-collapse` 已弃用（合并进 `dsh-ui-tools`），撤销默认启用。
- 推荐插件第三项改为已安装的 `dsh-vision-router`（替换 modlens）。

## [0.7.0] - 2026-08-27

### ✨ 新功能
- 内置默认启用 `dsh-model-select-style`：新装（首次服务就绪）自动安装并注册 bundles，推荐条目改用 GitHub 源。
- 插件面板推荐本地插件 `dsh-model-select-style`，主页支持 `file://` 打开本地目录。

## [0.6.4] - 2026-08-26

### 🐛 Bug 修复
- 修复管理面板 UI 问题：切换内核后标题栏 / 状态页版本号不刷新；restart 复用过期内核缓存。

### 📝 文档
- 架构总览：README 引用架构图 + HTML 动画版（`docs/dsh-architecture.html`）。

## [0.6.3] - 2026-08-26

### ⚡ 性能优化
- 修复性能审计发现的全部 33 项问题（稳定性 / 竞态 / IO / 资源泄漏）。

## [0.6.2] - 2026-08-25

### ✨ 新功能
- 内核安装性能优化：pnpm store 定向 + 失败自动重试。
- 安装源选择 UI（npm registry / npmmirror 镜像）。
- 托盘合并应用与内核更新检查。

### 🐛 Bug 修复
- CI 测试种子解析：`npm prefix -g` 动态定位全局 dsh（兼容 npm.cmd + shell），无种子环境优雅跳过。

## [0.6.1] - 2026-08-25

### ✨ 新功能
- 设置面板 API Key 管理（状态 / 保存 / 清除）+ 凭据清除能力。

### 🧹 维护
- 新增 GitHub Actions CI。
- 文档清理。

## [0.6.0] - 2026-08-25

### ✨ 新功能
- 内核管理阶段 B/C：内置 Node 运行时（真零门槛）+ 内核更新检测与一键升级 + 多 Profile 内核绑定 + 磁盘配额与卸载引用保护。

### 🐛 Bug 修复
- 修复内核安装两处真实缺陷（registry 根 URL 误用包元数据地址 / pnpm10 忽略 build scripts 误判失败），新增 E2E 验证脚本。

## [0.5.4] - 2026-08-25

### ✨ 新功能
- 会话通知按轮语义升级：turn 去重 + interrupted 过滤。
- 点击通知跳转会话语义 ID 精确匹配。

## [0.5.3] - 2026-08-25

### ✨ 新功能
- 插件面板内置推荐插件集。
- 标题栏右上角新增管理面板按钮，服务运行中可随时切回管理面板。

## [0.5.2] - 2026-08-25

### 🐛 Bug 修复
- 修复会话通知点击跳转标题不一致的根因（多候补 + 时间兜底）。

## [0.5.1] - 2026-08-25

### ✨ 新功能
- 会话通知点击跳转增强 + 真实端到端验证。

## [0.5.0] - 2026-08-25

### ✨ 新功能
- 会话完成通知改为真正的事件驱动（turn / end 即时通知）。

## [0.4.1] - 2026-08-25

### 🐛 Bug 修复
- 修复会话通知延迟与点击定位问题。

## [0.4.0] - 2026-08-25

### ✨ 新功能
- 会话完成通知增强：标题 / 项目信息 + 点击唤起并定位会话。

### 🧹 维护
- package.json 修复（test 脚本引号 / 移除 zstddec）。

## [0.3.2] - 2026-08-25

### ✨ 新功能
- 窗口几何记忆（尺寸 / 位置 / 最大化状态）。

## [0.3.1] - 2026-08-25

### ✨ 新功能
- 会话完成系统通知（任务完成场景）+ Image 优化。

## [0.3.0] - 2026-08-24

### ✨ 新功能
- 内核管理（阶段 A）：多版本共存。
- 标题栏按钮圆角优化。

### 📝 其他
- 移除定时自动备份（保留操作前自动快照）。

## [0.2.1] - 2026-08-24

### ✨ 新功能
- 定时自动备份（设置开关 + 周期配置，默认 24h）。

## [0.2.0] - 2026-08-24

### ✨ 新功能
- P2 高级功能落地：备份回滚 / 插件管理 / 自动更新。

### 🧹 维护
- 应用 / 安装包命名统一为 DSH-Exoskeleton。

## [0.1.0] - 2026-08-24

### ✨ 新功能
- DSH-Exoskeleton 桌面客户端初始提交（MVP）：原生窗口 / 自绘标题栏 / 系统托盘 / 单实例 / DSH 子进程管理（`--port 0` 自动分配 + 健康检查 + 崩溃自动重启）。

---

> 注：v0.7.4 / v0.7.5 发布时未打 git 标签（tag 由 v0.7.3 直接跳到 v0.7.6），版本条目依据提交历史整理。
