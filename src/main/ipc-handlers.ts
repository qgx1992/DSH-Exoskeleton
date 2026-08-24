/**
 * IPC 通信注册（文档 §6.1）
 * 主进程 ↔ 渲染进程（preload contextBridge 桥接）
 */
import { ipcMain, app, shell } from 'electron'
import { logger } from './logger'
import { configStore } from './config'
import { dshManager } from './dsh-manager'
import { windowManager } from './window-manager'
import { updater } from './updater'
import { rebuildMenu } from './tray'
import { checkSetupStatus, saveApiKey } from './setup'
import { backupManager } from './backup'
import { listInstalled, listCatalog, installPlugin, uninstallPlugin } from './plugins'
import type { AppConfig } from '../shared/types'

export function registerIpcHandlers(): void {
  // ---------- 首次启动引导 ----------
  ipcMain.handle('setup:check', () => checkSetupStatus())
  ipcMain.handle('setup:save', (_e, apiKey: string) => saveApiKey(apiKey))

  // ---------- 备份与回滚（§4.3.4）----------
  ipcMain.handle('backup:list', () => backupManager.list())
  ipcMain.handle('backup:create', (_e, name?: string) => backupManager.create(name ?? 'manual', 'manual'))
  ipcMain.handle('backup:restore', (_e, id: string) => backupManager.restore(id))
  ipcMain.handle('backup:delete', (_e, id: string) => backupManager.delete(id))

  // ---------- 插件管理（§4.3.3）----------
  ipcMain.handle('plugins:catalog', (_e, query?: string) => listCatalog(query))
  ipcMain.handle('plugins:installed', () => listInstalled())
  ipcMain.handle('plugins:install', (_e, pkg: string) => installPlugin(pkg))
  ipcMain.handle('plugins:uninstall', (_e, pkg: string) => uninstallPlugin(pkg))

  // ---------- DSH 管理 ----------
  ipcMain.handle('dsh:start', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await dshManager.start()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('dsh:stop', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await dshManager.stop()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('dsh:restart', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await dshManager.restart()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('dsh:getState', () => dshManager.getState())
  ipcMain.handle('dsh:getPort', () => dshManager.getState().port)

  // ---------- 配置 ----------
  ipcMain.handle('config:get', (): AppConfig => configStore.get())
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>): AppConfig => {
    const cfg = configStore.set(patch ?? {})
    // autoLaunch 变化同步系统登录项
    if (patch?.autoLaunch !== undefined) {
      app.setLoginItemSettings({
        openAtLogin: patch.autoLaunch,
        path: process.execPath,
        args: app.isPackaged ? [] : ['--hidden']
      })
    }
    // 自动备份参数变化 → 重新调度定时器
    if (patch?.autoBackup !== undefined || patch?.autoBackupIntervalHours !== undefined) {
      backupManager.syncAutoBackup(cfg.autoBackup, cfg.autoBackupIntervalHours)
    }
    rebuildMenu()
    return cfg
  })

  // ---------- 窗口 ----------
  ipcMain.handle('window:minimize', () => windowManager.getWindow()?.minimize())
  ipcMain.handle('window:toggleMaximize', () => windowManager.toggleMaximize())
  ipcMain.handle('window:close', () => windowManager.getWindow()?.hide())
  ipcMain.handle('window:isMaximized', () => windowManager.isMaximized())

  // ---------- 托盘 ----------
  ipcMain.handle('tray:show', () => windowManager.show())
  ipcMain.handle('tray:hide', () => windowManager.hide())

  // ---------- 更新 ----------
  ipcMain.handle('updater:check', () => updater.check(true))
  ipcMain.handle('updater:install', () => updater.install())

  // ---------- 日志 ----------
  ipcMain.handle('logs:list', (_e, limit?: number) => logger.list(limit ?? 200))
  ipcMain.handle('logs:openDir', () => {
    void shell.showItemInFolder(logger.getFile())
  })

  // ---------- 应用 ----------
  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('app:getDshHome', () => dshManager.resolveDshHome())
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
  })
}