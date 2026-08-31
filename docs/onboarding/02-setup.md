# 02 · 环境准备

> 目标：把本仓库在 Windows 上跑起来所需的环境一次配齐。
> 完成后你可以直接进入 [03-first-run.md](03-first-run.md)。

## 1. 系统要求

- **Windows 10 / 11**（当前目标平台，无边框窗口 + 托盘体验为 Windows 设计）
- 磁盘空间：仓库 + 依赖约 1–2GB，另加 DSH 内核（单内核 ~50MB+，可多版本共存，默认配额 1GB）

## 2. Node.js（必需）

本仓库通过 electron-vite 构建，要求 **Node.js ^18.0.0 或 >=20.0.0**（推荐 20 LTS 或 22 LTS）。

```powershell
# 检查是否已安装
node -v
npm -v

# 未安装：到 https://nodejs.org 下载 LTS 版，一路下一步即可
```

> 提示：仓库锁文件是 `package-lock.json`，**依赖管理用 npm**。
> 插件系统内部由 `dsh` 调用 pnpm 处理，**不需要你手动安装 pnpm**。

## 3. Git（必需）

```powershell
git --version   # 未安装则到 https://git-scm.com 安装

# 首次使用先配置身份（提交信息会用）
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

## 4. GitHub 账号（贡献时需要）

- 注册 [github.com](https://github.com)，fork 本仓库：`https://github.com/qgx1992/DSH-Exoskeleton`
- 推送代码建议配置 SSH：`https://docs.github.com/zh/authentication/connecting-to-github-with-ssh`
- 只读克隆用 HTTPS 即可，不需要账号

## 5. 安装依赖

```powershell
# 在仓库根目录
npm install
```

国内网络慢时，先切换 npm registry 镜像（全局）：

```powershell
npm config set registry https://registry.npmmirror.com
```

## 6. DSH 内核（两选一，桌面端也能自动处理）

桌面端遵循**壳核分离**：内核由桌面端下载托管。三种情况：

1. **什么都不做（推荐）**：首次启动时桌面端会自动安装默认内核（当前 `0.1.2-alpha.1`，见 `src/shared/kernel-defaults.ts`）并设为默认。无 Node 的机器会先自动下载内置 Node 运行时（~30MB，可通过 `DSH_NODE_DIST` 换 npmmirror 镜像），之后不需要系统 Node。
2. **手动安装全局 dsh**：`npm install -g @deepseek-ai/dsh`。
3. **手动指定**：设置环境变量 `DSH_EXECUTABLE` 指向 dsh 可执行文件。

主进程定位 `dsh` 的顺序（`src/main/dsh-manager.ts`）：

```
1. DSH_EXECUTABLE 环境变量（显式指定）
2. npm/pnpm 全局安装的 @deepseek-ai/dsh（lib/bin.js 由 Node 直接运行）
3. PATH 中的 dsh.cmd
```

> 内核从 npm registry 安装，国内网络可切 npmmirror 镜像加速（见 `docs/KERNEL-MANAGER-DESIGN.md`）。

## 7. API Key（首次启动时配置）

- 桌面端首次启动会检测 `~/.dsh/.credentials.yaml`，未配置时弹出**首次启动向导**引导填入 DeepSeek API Key；
- Key 写入本地凭据文件（仓库外），**不会出现在代码或日志里**；
- 安全红线：严禁在任何代码、文档、提交信息中硬编码 API Key。

## 8. 环境自检清单

```powershell
node -v      # ^18.0.0 || >=20.0.0 ✓
npm -v       # 有输出 ✓
git --version
npm install  # 在仓库根目录执行，无报错 ✓
```

全部通过后，进入 [03-first-run.md](03-first-run.md) 首次运行。
