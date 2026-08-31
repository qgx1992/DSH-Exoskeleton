# alpha.2 内核启动崩溃 · 运行时自证报告

> 日期：2026-08-30 ｜ 对象：DSH 内核 `@deepseek-ai/dsh@0.1.2-alpha.2`（桌面壳托管安装）
> 方式：隔离临时 `DSH_HOME`（不触碰线上 `~/.dsh` 与运行中的服务），逐项试启动取证。

## 1. 背景

内核面板安装官方 `0.1.2-alpha.2` 并设为默认后，`dsh web` 启动即崩溃（exit 1），桌面端自动重启 10 次后停在 error。此前静态分析怀疑「任意 web profile 都会因内核自带 ui-deliverables 插件崩溃」，本报告用运行时实验修正并钉死根因。

## 2. 实验方法与结果

实验环境：内置 Node `runtimes\node\node.exe` + 内核 `kernels\0.1.2-alpha.2\node_modules\@deepseek-ai\dsh\lib\bin.js`；`DSH_HOME=%TEMP%\dsh-trial-*`（最小 profile 与真实 profile 克隆各一套，真实插件目录以 junction 只读引用）；每次试启动 50–70s 观察窗口后强杀进程树。

| Probe | 条件 | 结果 |
|---|---|---|
| A1 | 最小 profile（base+web-app）`web --dump-config` | exit 0；配置树含 `- id: ui-deliverables / name: '@deepseek-ai/dsh-client-ui-deliverables'`（web-app bundle 提供） |
| A2 | 同上 + `--patch patch-disable-ui-deliverables.yml` | exit 0；该行变为 `disabled: true`，注释标注 `patched by …patch-disable-ui-deliverables.yml` |
| C（对照组） | 最小 profile，**无补丁**试启动 | **成功**：打印 `dsh web: http://127.0.0.1:16356/?token=…`，存活至超时被杀 |
| D（复现组） | **真实 profile**（13 个 bundles，插件目录 junction），无补丁试启动 | **exit 1 复现**，错误与桌面日志逐字符一致：`TypeError: ctx.systemPrompt.getSectionOrder is not a function`（ui-deliverables `lib/index.js:19:27`），外层 `plugin tree failed to load: failed to apply loader entry include (cordis:include)` |
| E（修复组） | **真实 profile + `--patch` 禁用 ui-deliverables** | **成功**：打印 `dsh web: http://127.0.0.1:37940/?token=…`，stderr 为空，存活正常 |

## 3. 根因（修正后，证据链完整）

1. 真实 profile 的 `~/.dsh/profiles/web/node_modules/@deepseek-ai/` 下**残留一份旧版 `dsh-system-prompt@0.1.2-alpha.1`**：含 `section()`/`assemble()`，**没有 `getSectionOrder`**。
2. dsh 行级插件解析**优先走 profile 目录的 Node parent walk**（崩溃堆栈中的 `…/profiles/web/#ui-deliverables`、`#include` 即证），因此 `ctx.systemPrompt` 注入到的是这份**旧实例**。
3. alpha.2 内核自带的 `dsh-client-ui-deliverables@0.1.2-alpha.2`（web-app bundle 引入）调用 `ctx.systemPrompt.getSectionOrder("DELIVERABLE_FILE_REFERENCES")` → 该方法不存在 → TypeError → include/插件树加载失败 → `dsh web` exit 1。
4. 最小/全新 profile 没有旧拷贝 → 回退用内核自带 `dsh-system-prompt@0.1.2-alpha.2`（**有** `getSectionOrder`）→ 启动正常（Probe C）。
5. 官方 master 已**整体删除** `getSectionOrder`，改为 `FIRST_PARTY_SECTION_ORDER` 常量（ui-deliverables `src/index.ts`、system-prompt 全库 0 处匹配）→ 下一版官方修复方向已明确。

一句话：**不是 alpha.2 内核单独的问题，而是「alpha.2 内核 + 真实 profile 里的旧版 dsh-system-prompt 拷贝」组合不兼容**；官方 master 已通过删除该 API 从根上解决。

## 4. 修复路径（已实证有效）

启动时注入官方一等机制 `--patch` 叠层，按补丁注册表禁用不兼容行（Probe E 成功，全程不写用户 profile、不改内核）：

```yaml
# kernel-patches/0.1.2-alpha.2.yml （R-24 壳子自动生成）
- id: ui-deliverables
  disabled: true
- id: dsh-market
  disabled: true
- id: better-sidebar
  disabled: true
```

### 实施阶段补遗（2026-08-30 实现 R-24 时实测发现第二、三处不兼容）

克隆真实 profile 逐行试启动定位到**同车次下的额外两处**（均源于 `@deepseek-ai/dsh-settings@0.1.2-alpha.2` 移除旧导出）：

| 失败条目 | 缺失导出 | 说明 |
|---|---|---|
| `dshmarket`（行 id `dsh-market`） | `installSettingsSection` | dshmarket@1.38 peer 声明 `^0.1.0-rc.7 \|\| ^0.1.1-rc.2`，解析到的 alpha.2 版已移除该导出 |
| `dsh-better-sidebar`（行 id `better-sidebar`） | `settingsNamespace` | 同上 |

- 副作用：`ui-deliverables` 禁用 → 「终答交付引用」UI 特性缺失；`dsh-market`/`better-sidebar` 禁用 → 插件市场页/侧边栏增强在 alpha.2 下暂缺（其他内核不受影响）。
- 根治方向（可选，不动壳子）：
  1. profile 固定安装 `@deepseek-ai/dsh-settings@0.1.1-rc.2`（满足插件 peer 声明，两个插件无需禁用）——需在 ~/.dsh profile 安装依赖，属用户数据改动，待授权；
  2. 或等 dshmarket / dsh-better-sidebar 发布与 alpha.2 兼容的新版；
  3. 官方移除/改名相关 API 的下一版内核发布后，注册表补丁自动退役。
- 最终实机探针（`scripts/probe-compat-gate.cjs`，真实内核 + 真实 profile 克隆）：
  ```
  A) 无补丁试启动 → 失败（dsh-market installSettingsSection 缺失，复现真实崩溃面）
  B) 带三行补丁试启动 → ok=true url=http://127.0.0.1:41015/?token=… stderr 空
  ```
- 配套（桌面壳工程化，已落地 R-24）：切换默认/档案绑定前“克隆 DSH_HOME 试启动门禁”（失败拦截并记录 `bootHealth=failed`，错误摘要直指具体失败条目）；服务崩溃循环自动回滚到上一默认；`kernels.json` 持久化健康状态；内核面板展示「启动失败/兼容补丁」徽标；`--patch` 由 spawn 按注册表自动注入。

## 5. 实验卫生

- 全程使用隔离 `DSH_HOME=%TEMP%\dsh-trial-*`；真实 profile 只读（junction），未修改 `~/.dsh` 任何文件。
- 每个试启动进程树均 taskkill 清理；临时目录已删除；无残留 dsh-trial 进程。
- 运行中的桌面服务（alpha.1，端口 27206）未受影响。

## 6. 附：关键输出片段（Probe D 复现）

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): loader entries failed to apply
[cause]: Error: failed to apply loader entry ui-deliverables (@deepseek-ai/dsh-client-ui-deliverables):
         ctx.systemPrompt.getSectionOrder is not a function
  [cause]: TypeError: ctx.systemPrompt.getSectionOrder is not a function
      at new apply (…/dsh-client-ui-deliverables/lib/index.js:19:27)
```

## 7. 结论

「设为默认就启动不了」的直接原因：alpha.2 内核的 ui-deliverables 插件与真实 profile 的旧 `dsh-system-prompt@0.1.2-alpha.1` 拷贝 API 不匹配，启动时插件树加载崩溃。运行时自证完成：复现 100%（Probe D）、`--patch` 绕过 100%（Probe E）、最小环境对照排除内核单点故障（Probe C）。官方 master 已删除该 API，等下一版内核即可彻底解决；过渡期可用壳子侧 `--patch` 兼容补丁。