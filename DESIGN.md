# Design — DSH-Exoskeleton

本应用的锁定设计系统。后续所有 UI 改动先读此文件；与零散参考冲突时以本文件为准。
需要扩展系统时修改本文件（新增 `## Variants` 段），不要在页面里局部覆盖。

## System

- Genre · modern-minimal（桌面工具台 / 仪表盘）
- Macrostructure · Workbench（左侧导航 + 内容卡片的 app shell）
- Theme · custom「黑金仪表台」——深蓝黑三层表面 + 金色 accent（呼应黑金鲸鱼品牌）
- Axes · dark-canvas / system-display / gold-accent (hue 87)

## Tokens（唯一来源：`src/renderer/styles/global.css` 的 `@theme`）

所有颜色/字体/圆角/缓动一律经由 Tailwind token 工具类（`bg-surface`、`text-ink-2`、
`rounded-control`、`ease-hallmark`……）。**禁止再出现内联 hex / rgb / slate-* 旧调色板。**

| 组 | Token | 值（OKLCH） | 用途 |
| --- | --- | --- | --- |
| 表面 | `canvas` | 0.148 0.018 258 | 窗口底 |
| | `surface` | 0.185 0.020 258 | 卡片 / 侧栏 / 标题栏 |
| | `surface-2` | 0.225 0.024 258 | 输入框 / 次级按钮 / hover |
| | `rule` / `rule-strong` | 0.275 / 0.34 (0.026-0.028 258) | 分隔线 / 边框 |
| 文字 | `ink` | 0.900 0.010 250 | 标题 / 正文 |
| | `ink-2` | 0.740 0.018 252 | 辅助文字（小字 ≥4.5:1 ✓） |
| | `ink-3` | 0.560 0.022 255 | 弱化文字（仅非关键信息） |
| accent | `accent` / `accent-hover` / `accent-ink` | 0.8/0.85 (0.105-0.125 87-90) / 0.2 0.04 85 | 金色主操作；accent-ink 为金底上的文字 |
| 语义 | `info` cyan 215 / `success` emerald 162 / `warning` amber 75 / `danger` red 25 | | 状态与反馈 |
| 焦点 | `focus-ring` | 0.850 0.090 92 | 全局键盘焦点环 |

- 字号刻度：`text-2xs` 11 · `text-xs` 12 · `text-sm` 13 · `text-base` 14 · `text-lg` 17 · `text-xl` 20
- 数据（端口/版本/大小/日志/密钥）一律 `font-mono`（Cascadia Code / Consolas，系统内置）
- 圆角：`rounded-control` 6 · `rounded-card` 12 · `rounded-chip` 999（模态沿用 2xl 16）

## Accent 纪律

金色每屏占比 ≤5%：主按钮（每视图 1 个）、侧栏激活项、焦点环、品牌图标。
状态标记用语义 Badge：cyan=当前默认/激活/信息链接，amber=待办/可升级，green=成功/健康，
red=危险/错误，gray=中性。**服务「运行中」用 success 呼吸光点，仅「启动中」用 ping。**

## CTA voice

- Primary · 金色实底 + accent-ink 文字 · rounded-control · px-3.5 py-[7px] text-sm
- Secondary · surface-2 底 + rule 边 · 同圆角
- Ghost · 透明，hover 浮出白 5% 底
- Danger · 红字 ghost，hover 红底 10%；窗口关闭钮例外（hover 红实底）
- Accent（soft）· 金 15% 底 + 金字，用于行内「激活/设为默认」类操作

## Motion

- 缓动 `ease-hallmark` cubic-bezier(0.16,1,0.3,1)；时长 140–240ms
- Tab 切换：180ms 淡入 + 4px 上浮（`.panel-enter`）
- 开关/进度条走 transform（translateX / scaleX），不动布局属性
- `prefers-reduced-motion` 全量降级；焦点环永不参与动画

## Interactions

- 全局 `:focus-visible` 金白描边环（global.css base 层）
- 空状态统一 `EmptyState`：图标 + 一句话 + 引导动作
- 日志/错误信息/代码片段可选中复制（`.selectable`）；全局 user-select:none 保持
- 静默成功优先：复制反馈用按钮内「✓ 已复制」，不弹 toast

## What pages MUST share

标题栏与侧栏结构、accent 色与放置、字阶与 mono 用法、按钮变体、卡片语言（surface + rule 边 + 12px 圆角）。

## What pages MAY differ on

内容布局（hero 卡 vs 表单行 vs 列表）、每屏主操作的文案与数量（仍 ≤1 个 primary）。
