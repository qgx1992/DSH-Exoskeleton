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

let tray: Tray | null = null

function iconPath(): string {
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    return path.join(__dirname, '../../resources/tray.png')
  }
  return path.join(process.resourcesPath, 'tray.png')
}

export function createTray(): Tray {
  tray = new Tray(iconPath())
  tray.setToolTip('DeepSeek Harness 桌面客户端')
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
        const info = await updater.check()
        if (info.available && info.latest) {
          const r = await dialog.showMessageBox(windowManager.getWindow()!, {
            type: 'info',
            title: '发现新版本',
            message: `发现新版本 ${info.latest}（当前 ${info.current}）`,
            detail: '是否前往发布页下载？',
            buttons: ['前往下载', '取消'],
            defaultId: 0,
            cancelId: 1
          })
          if (r.response === 0 && info.url) void shell.openExternal(info.url)
        } else {
          await dialog.showMessageBox(windowManager.getWindow()!, {
            type: 'info',
            title: '检查更新',
            message: `当前已是最新版本 ${info.current}`,
            buttons: ['好的']
          })
        }
      }
    },
    {
      label: '关于',
      click: async () => {
        await dialog.showMessageBox(windowManager.getWindow()!, {
          type: 'info',
          title: '关于',
          message: 'DeepSeek Harness 桌面客户端',
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