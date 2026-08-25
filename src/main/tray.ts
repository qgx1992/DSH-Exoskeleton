/**
 * 系统托盘（文档 §4.1.3）
 * - 单击唤回窗口
 * - 右键菜单：打开主界面 / 启动-停止 DSH / 开机自启 / 打开日志目录 / 检查更新 / 关于 / 退出
 */
import { Tray, Menu, app, shell, dialog } from 'electron'
import path from 'node:path'
import { logger } from './logger'
import { windowManager } from './window-manager'
import { dshManager } from './dsh-manager'
import { configStore } from './config'
import { updater } from './updater'
import { kernelManager } from './kernel-manager'

let tray: Tray | null = null

function iconPath(): string {
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    return path.join(__dirname, '../../resources/tray.png')
  }
  return path.join(process.resourcesPath, 'tray.png')
}

export function createTray(): Tray {
  tray = new Tray(iconPath())
  tray.setToolTip('DSH-Exoskeleton 桌面客户端')
  tray.on('click', () => {
    windowManager.show()
  })
  rebuildMenu()
  return tray
}

export function rebuildMenu(): void {
  if (!tray) return
  const state = dshManager.getState()
  const cfg = configStore.get()
  const isRunning = state.status === 'running'
  const isStarting = state.status === 'starting'

  const serviceItem: Electron.MenuItemConstructorOptions = isRunning
    ? { label: '停止 DSH 服务', click: () => void dshManager.stop() }
    : {
        label: isStarting ? 'DSH 启动中…' : '启动 DSH 服务',
        enabled: !isStarting,
        click: () => void dshManager.start()
      }

  const menu = Menu.buildFromTemplate([
    { label: '打开主界面', click: () => windowManager.show() },
    { type: 'separator' },
    serviceItem,
    {
      label: '开机自启',
      type: 'checkbox',
      checked: cfg.autoLaunch,
      click: async (item) => {
        await configStore.set({ autoLaunch: item.checked })
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          args: app.isPackaged ? [] : ['--hidden']
        })
      }
    },
    { type: 'separator' },
    {
      label: '打开日志目录',
      click: () => {
        void shell.showItemInFolder(logger.getFile())
      }
    },
    {
      label: '检查更新…',
      click: async () => {
        // #4：合并检查应用更新（electron-updater/GitHub API）+ 内核更新（npm dist-tags）
        const [appInfo, kernelInfo] = await Promise.all([updater.check(true), kernelManager.checkUpdate()])
        const win = windowManager.getWindow()
        if (!win) return
        const parts: string[] = []
        if (appInfo.available && appInfo.latest) {
          parts.push('应用新版本 v' + appInfo.latest + '（当前 v' + appInfo.current + '）')
        }
        if (kernelInfo.available && kernelInfo.latest) {
          parts.push('内核新版本 v' + kernelInfo.latest + '（当前 v' + (kernelInfo.current ?? '系统 dsh') + '）')
        }
        if (parts.length === 0) {
          await dialog.showMessageBox(win, {
            type: 'info',
            title: '检查更新',
            message: '当前已是最新（应用 v' + appInfo.current + '）',
            detail: kernelInfo.error ? '内核版本检测失败：' + kernelInfo.error : undefined,
            buttons: ['好的']
          })
          return
        }
        const buttons: string[] = ['取消']
        const actions: Array<() => void> = [() => { /* noop */ }]
        if (appInfo.available && appInfo.url) {
          buttons.unshift('前往下载应用')
          actions.unshift(() => void shell.openExternal(appInfo.url as string))
        }
        if (kernelInfo.available) {
          buttons.unshift('打开内核面板')
          actions.unshift(() => {
            windowManager.show()
            windowManager.setAdminPanelVisible(true)
          })
        }
        const r = await dialog.showMessageBox(win, {
          type: 'info',
          title: '发现更新',
          message: '发现以下更新：\n· ' + parts.join('\n· '),
          detail: '应用更新需前往发布页下载安装；内核更新可在内核面板一键升级。',
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1
        })
        if (r.response >= 0 && r.response < actions.length) actions[r.response]()
      }
    },
    {
      label: '关于',
      click: async () => {
        await dialog.showMessageBox(windowManager.getWindow()!, {
          type: 'info',
          title: '关于',
          message: 'DSH-Exoskeleton 桌面客户端',
          detail: `版本 ${app.getVersion()}（DSH 内核 ${state.version ?? '未知'}）\nDSH Home: ${dshManager.resolveDshHome()}`,
          buttons: ['好的']
        })
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => windowManager.quit() }
  ])
  tray.setContextMenu(menu)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

export function getTray(): Tray | null {
  return tray
}