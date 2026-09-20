# DeepSeek Harness Desktop Client (DSH-Exoskeleton)

[中文](README.md) | [English](README.en.md)

> A unified development plan based on research of 7 community DSH desktop projects ([Dev Doc](DEV_DOC.md)).

A lightweight, clean, feature-complete DSH desktop shell: wraps the official `dsh web` into a **double-click-to-run** Windows desktop app.
Following the **shell-kernel separation** principle — **no changes to the DSH core**, seamless tracking of official upgrades; by default shares `~/.dsh`, so existing configs require zero migration.

## Latest Release Highlights (v0.9.6)

> [Release notes](https://github.com/qgx1992/DSH-Exoskeleton/releases/tag/v0.9.6) · Full history in the [changelog](CHANGELOG.md)

- **Two independent switches on the Update page: "Auto check for updates" + "Auto download updates"** (both on by default, preserving existing behaviour). They are **orthogonal** — "don't go online to check" and "you may check, but don't eat my bandwidth / don't install behind my back" are genuinely different wishes, and one switch cannot express both. Turning **check** off means no silent network call at startup (manual check in the panel still works); turning **download** off means a new version is only *announced*, never downloaded, and it will not be installed on quit either. If you worry that disabling download leaves you unable to update: the new **"Download update"** button in the panel is a first-class manual path — verified against the upstream electron-updater implementation, where `autoDownload` only controls whether `checkForUpdates()` downloads as a side effect, while an explicit `downloadUpdate()` is not constrained by it (the source comment itself documents using it when `autoDownload` is `false`). Both switches take effect **immediately** (no restart), and older configs without these fields are treated as **enabled**, so upgrading users see no behaviour change.
- **The sidebar footer is now a single row of four small buttons** (Settings / Web DeepSeek / Management panel / Collapse toggle): the official footer was two rows (a 69px slot row plus the official full-width Settings button at 50px), **119px** in total. It is now one row of 32×32 icon buttons, evenly distributed across the row (centres always at 1/8·3/8·5/8·7/8 of the width, adapting automatically to sidebar width). It sticks to **CSS only, never moving DOM** (moving slot nodes makes framework re-renders and observers fight each other — a 100% CPU renderer lockup); the official Settings button keeps its exact behaviour (the click handler is still the official one), and "Expand all / Collapse all" is merged into one two-way toggle. In rail (collapsed) mode only Settings remains.
- **Two footer layout defects fixed**: ① third-party plugins insert their element at the *front* of the slot and span the whole row, which pushed the shell buttons into the middle (measured: 131px footer, buttons not on the bottom row) — the shell buttons are now wrapped in a group container pinned to the bottom row via `order`, **without moving third-party nodes**; ② the settings column reserved space and left the third-party content with a gap on the left (measured x=76..268, 64px blank) — absolute positioning now lets it fill from the footer's left edge (x=12..268, aligned with `footArea`).
- **Verifiability**: this release adds the `updater-switch` unit suite (19 assertions) plus two real-machine probes — `probe-updater-switch` (20 assertions: fakes `app.isPackaged` and reads the actual `autoDownload` / `autoInstallOnAppQuit` values) and `probe-update-ui` (23 assertions: loads the built renderer in a real Electron window and asserts switch rendering, click payloads and button visibility). Run both with `npm run probe:update`.

## Features

| Module | Description |
| :--- | :--- |
| DSH subprocess management | Start/stop/restart `dsh web`, `--port 0` auto-assigns the port, health checks, auto-restart on crash |
| Native window | Title-bar-less window + native window buttons overlaid at the top-right (content fills from y=0); the top row is DSH's own sidebar brand row, with three drag regions for moving the window |
| System tray | Single-click to restore, right-click menu (open / start-stop service / launch at startup / logs / update / about / quit) |
| Single instance | Double-click brings up the existing window |
| Dashboard | Unified management panel for status / settings / logs / updates |
| First-run wizard | Detects `~/.dsh/.credentials.yaml`; shows a wizard when no API Key is configured and writes the Key into the local credentials file |
| Native notifications | Windows notifications for service ready / error / crash-restart / session done / **question card awaiting answer** (toggleable) |
| Backup & rollback | Manual archive + automatic snapshots (before plugin install/uninstall, before restore) + one-click rollback; snapshots stored in `userData\backups` |
| Plugin management | GitHub topic `dsh-plugin` + npm dual-source catalogs, one-click install/uninstall (reuses `dsh plugin`), conflict pre-check + automatic backup before operations |
| Auto-update | NSIS installers use electron-updater silent download → notify → one-click restart & install; the portable build guides a manual download |
| Kernel management (Phase A/B/C/D) | DSH multi-version coexistence: install / default routing / uninstall + built-in Node runtime (zero barrier) + first-launch default kernel provisioning + kernel update detection & one-click upgrade + multi-Profile kernel binding + disk quota + **reliable uninstall (rename-first: a failed delete never corrupts files) + startup reconciliation (detect & one-click clean damaged kernels)** + **compat-patch auto-injection for buggy alpha kernels (R-24: trial-boot gate + crash auto-rollback)** |
| Data reuse | `DSH_HOME` environment variable takes priority, otherwise `%USERPROFILE%\.dsh` |
| Security isolation | Listens only on `127.0.0.1`, renderer sandbox, `contextIsolation`, Node integration disabled |

## Tech Stack

Electron + TypeScript + React + Tailwind CSS + Vite (electron-vite) + electron-builder

## Architecture Overview

![DSH-Exoskeleton Architecture](docs/dsh-architecture-preview.png)

> Interactive animated version: [View architecture diagram (GitHub Pages)](https://qgx1992.github.io/DSH-Exoskeleton/docs/dsh-architecture.html)
> When Pages is not enabled, use this third-party preview: [htmlpreview](https://htmlpreview.github.io/?https://github.com/qgx1992/DSH-Exoskeleton/blob/main/docs/dsh-architecture.html)

## Directory Structure

```
├── src/
│   ├── main/          # Electron main process
│   │   ├── index.ts           # Entry: window / lifecycle / single instance
│   │   ├── window-manager.ts  # Frameless window + WebContentsView hosting the DSH Web UI
│   │   ├── dsh-manager.ts     # DSH subprocess management (start/stop/health check/crash-restart)
│   │   ├── tray.ts            # System tray
│   │   ├── updater.ts         # Update checks
│   │   ├── ipc-handlers.ts    # IPC communication
│   │   ├── config.ts          # Config management (userData/config.json)
│   │   └── logger.ts          # File logging (rotated)
│   ├── preload/       # Typed contextBridge bridge
│   └── renderer/      # Shell UI (title bar + dashboard)
│       └── components/panels/ # Status / Settings / Logs / Updates
├── shared/            # Shared types between main and renderer
├── resources/         # Icons
├── scripts/           # Icon generation and other scripts
├── electron-builder.yml
└── electron.vite.config.ts
```

## Development

```bash
# Install dependencies
npm install

# Generate icons (first time)
npm run gen:icon

# Development mode (HMR)
npm run dev

# Type check
npm run typecheck

# Build
npm run build

# Package (NSIS installer + portable)
npm run dist
```

## Build Artifacts

```
dist/DSH-Exoskeleton-Setup-0.6.3.exe          # NSIS installer
dist/DSH-Exoskeleton-Portable-0.6.3.exe       # Single-file portable build
dist/win-unpacked/                            # Portable folder (no install needed)
```

## DSH Executable Resolution

The main process locates `dsh` in the following order:

1. The `DSH_EXECUTABLE` environment variable (explicitly specified)
2. npm/pnpm global install of `@deepseek-ai/dsh` (`lib/bin.js` is run directly by Node, no path dependency)
3. `dsh.cmd` on the PATH

> "Zero barrier" goal: future versions will bundle a DSH kernel so users don't have to install dsh manually.

## Configuration

Stored in `%APPDATA%\DSH-Exoskeleton\config.json`:

| Config | Purpose | Default |
| :--- | :--- | :--- |
| `port` | Web service port | `0` (auto-assigned) |
| `workspace` | Agent workspace (reserved) | empty |
| `autoLaunch` | Launch at startup | `false` |
| `apiKey` | DeepSeek API Key (system-level encryption, P1 guide) | empty |
| `dshHome` | DSH Home override | empty (official rules) |
| `activeProfileId` | Active configuration profile | `default` |
| `kernelsQuotaMB` | Kernel store disk quota (MB, 0 = unlimited) | `1024` |
| `defaultKernelVersion` | Default managed kernel version (written by first-launch provisioning) | `null` |
| `autoStartService` | Auto-start service at launch | `true` |
| `minimizeToTray` | Close window hides to tray | `true` |

## Logs

`%APPDATA%\DSH-Exoskeleton\dsh-desktop.log` (2MB rotation); the dashboard provides real-time viewing, and the tray menu can open the log directory.

## Roadmap

- [x] Phase 1 — MVP: scaffolding / native window / tray / single instance / DSH process management / auto port assignment
- [x] Phase 2 — Experience polish: API Key first-run wizard / data reuse / security isolation / log viewer / native notifications / launch at startup
- [x] Phase 3 (mostly): auto-update (electron-updater silent download + one-click restart) / dashboard (status / settings / kernel / plugins / backups / logs / updates) /
      plugin manager (dual-source catalogs + conflict pre-check + auto backup) / backup & rollback / three distribution forms
- [x] Kernel management Phase A/B/C/D: managed install / default routing / uninstall; built-in Node runtime (truly zero barrier); first-launch default kernel provisioning (auto-ready on fresh installs);
      kernel update detection + one-click upgrade; multi-Profile kernel binding (profile panel); disk quota & uninstall reference protection
- [ ] Phase 4: cross-platform / community ecosystem

## Kernel Management (Phase B/C/D shipped)

- **First-launch default kernel provisioning (Phase D)**: on a fresh install, the default kernel (currently `0.1.5-rc.1`, see `src/shared/kernel-defaults.ts`) is installed automatically on first launch and set as the default — machines without Node download the built-in runtime first; upgrading users are skipped automatically, and failures retry on the next launch.
- **Built-in Node runtime**: one-click download from the kernel panel (~30MB, nodejs.org; switchable to the npmmirror mirror via `DSH_NODE_DIST`). No system Node needed afterwards (truly zero barrier).
- Install goes through the npm registry (switchable to the npmmirror mirror to accelerate domestic networks, see `docs/KERNEL-MANAGER-DESIGN.md`).
- The dependency tree is large (a single kernel is ~50MB+), so the first install time depends on the network; the kernel store has disk quota protection (`kernelsQuotaMB`, default 1GB).
- **Multi-Profile**: each profile can bind a different kernel version; switching profiles switches the kernel (service auto-restarts).

## Reference Projects

- [dsh-clean-desktop-shell](https://github.com/Icather/dsh-clean-desktop-shell)
- [DSHDesktop (CCMu04)](https://github.com/CCMu04/DSHDesktop)
- [dsh-desktop (SnowCrescenter)](https://github.com/SnowCrescenter-tech/dsh-desktop)
- [dsh-desktop (kevenxz)](https://github.com/kevenxz/dsh-desktop)
- [dsh-desktop (csyyywy)](https://github.com/csyyywy/dsh-desktop)
- [deepseek-harness-desktop (Tauri)](https://github.com/dsh-tauri-desk/deepseek-harness-desktop)
- [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)
- [DeepSeek Harness Official](https://github.com/deepseek-ai/deepseek-harness)