/**
 * IPC 通信注册（文档 §6.1）
 * 主进程 ↔ 渲染进程（preload contextBridge 桥接）
 */
import { ipcMain, app, shell, clipboard } from 'electron'
import { logger } from './logger'
import { configStore } from './config'
import { dshManager } from './dsh-manager'
import { windowManager } from './window-manager'
import { updater } from './updater'
import { rebuildMenu } from './tray'
import { checkSetupStatus, saveApiKey, clearApiKey } from './setup'
import { backupManager } from './backup'
import { listInstalled, listCatalog, installPlugin, uninstallPlugin, checkPluginUpdates, upgradePlugin } from './plugins'
import { kernelManager } from './kernel-manager'
import { runtimeManager } from './runtime-manager'
import { trialBootManagedKernel, compatPatchPathFor } from './kernel-compat'
import { listProfiles, createProfile, deleteProfile, activateProfile, setProfileKernel } from './profiles'
import { listSessions, openSession, removeSession, exportSession, showSessionInFolder, isSessionId } from './sessions'
import { notify } from './notify'
import type { AppConfig } from '../shared/types'

export function registerIpcHandlers(): void {
  // R-24: 内核崩溃循环 → 自动回滚默认到上一可用版本（防「设为默认即裸崩循环」）
  dshManager.onBootFailure = (info) => {
    try {
      const cfg = configStore.get()
      if (cfg.kernelMode !== 'managed') return
      const bad = info.version ?? cfg.defaultKernelVersion
      if (!bad || cfg.defaultKernelVersion !== bad) return
      const prev = cfg.previousKernelVersion
      if (!prev || prev === bad || !kernelManager.listInstalled().some((k) => k.version === prev)) return
      if (kernelManager.bootHealthOf(prev) === 'failed') {
        logger.warn('kernel auto-rollback skipped: previous default known-unhealthy', { prev })
        return
      }
      logger.error('kernel crash-loop detected, auto-rollback default', {
        bad,
        prev,
        attempts: info.attempts,
        lastError: info.lastError
      })
      kernelManager.setBootHealth(bad, 'failed', info.lastError ?? '连续崩溃')
      configStore.set({ defaultKernelVersion: prev, previousKernelVersion: null })
      const st = dshManager.getState().status
      if (st === 'error' || st === 'stopped') {
        setTimeout(() => {
          void dshManager.start().catch((err) => logger.warn('restart after rollback failed', err))
        }, 800)
      }
    } catch (err) {
      logger.warn('kernel auto-rollback failed', err)
    }
  }

  // ---------- 首次启动引导 ----------
  ipcMain.handle('setup:check', () => checkSetupStatus())
  ipcMain.handle('setup:save', (_e, apiKey: string) => saveApiKey(apiKey))
  ipcMain.handle('setup:clear', () => clearApiKey())

  // ---------- 备份与回滚（§4.3.4）----------
  ipcMain.handle('backup:list', () => backupManager.list())
  ipcMain.handle('backup:create', (_e, name?: string) => backupManager.create(name ?? 'manual', 'manual'))
  ipcMain.handle('backup:restore', (_e, id: string, entries?: string[]) => backupManager.restore(id, entries))
  ipcMain.handle('backup:delete', (_e, id: string) => backupManager.delete(id))

  // ---------- 插件管理（§4.3.3）----------
  ipcMain.handle('plugins:catalog', (_e, query?: string) => listCatalog(query))
  ipcMain.handle('plugins:installed', () => listInstalled())
  ipcMain.handle('plugins:install', (_e, pkg: string) => installPlugin(pkg))
  ipcMain.handle('plugins:uninstall', (_e, pkg: string) => uninstallPlugin(pkg))
  ipcMain.handle('plugins:checkUpdate', () => checkPluginUpdates())
  ipcMain.handle('plugins:upgrade', (_e, name: string, latest?: string) => upgradePlugin(name, latest))

  // ---------- 内核管理（多版本共存）----------
  ipcMain.handle('kernels:installed', () => kernelManager.listInstalled())
  ipcMain.handle('kernels:available', () => kernelManager.listAvailable())
  ipcMain.handle('kernels:install', (_e, version: string, registry?: string) => kernelManager.install(version, registry))
  ipcMain.handle('kernels:uninstall', (_e, version: string) => kernelManager.uninstall(version))
  ipcMain.handle('kernels:setDefault', async (_e, version: string | null) => {
    // R-1: 设置前校验版本已安装（默认内核不允许指向未安装版本）
    if (version !== null && !kernelManager.listInstalled().some((k) => k.version === version)) {
      return { ok: false, error: '内核 v' + version + ' 未安装，无法设为默认' }
    }
    const oldVersion = configStore.get().kernelMode === 'managed' ? configStore.get().defaultKernelVersion : null
    if (version === oldVersion) return { ok: true }

    // R-24: 切到托管版本先在克隆 DSH_HOME 上试启动（失败不改配置；已验过 ok 则直接放行——
    // spawn 时仍会按注册表注入兼容补丁，无需重复验证）
    if (version !== null && kernelManager.bootHealthOf(version) !== 'ok') {
      const dshHome = dshManager.resolveDshHome()
      const t0 = Date.now()
      const trial = await trialBootManagedKernel(version, dshHome, { timeoutMs: 60_000 })
      const took = Math.round((Date.now() - t0) / 1000)
      if (!trial.ok) {
        kernelManager.setBootHealth(version, 'failed', trial.error)
        kernelManager.setCompatPatch(version, null)
        logger.error('kernel default switch blocked by trial boot', { version, error: trial.error, took })
        return {
          ok: false,
          error:
            '内核 v' + version + ' 试启动失败（' + took + 's）：' +
            (trial.error ?? '未知错误') +
            '。已保留当前默认 ' + (oldVersion ?? '系统 dsh') + '，未切换。'
        }
      }
      kernelManager.setBootHealth(version, 'ok')
      kernelManager.setCompatPatch(version, trial.patchUsed ? compatPatchPathFor(version) : null)
      logger.info('kernel default switch trial ok', { version, took, patchUsed: trial.patchUsed, url: trial.url })
    }

    // 提交切换（记录上一默认，供崩溃自动回滚使用）
    const cfg = configStore.set({
      defaultKernelVersion: version,
      previousKernelVersion: oldVersion ?? null
    })
    if (version !== null) kernelManager.setCompatPatch(version, compatPatchPathFor(version))
    // 服务运行中则自动换内核重启
    if (dshManager.getState().status === 'running') {
      await dshManager.restart()
    }
    const patched = version !== null && kernelManager.bootHealthOf(version) === 'ok' && !!kernelManager.listInstalled().find((k) => k.version === version)?.compatPatch
    return {
      ok: cfg.defaultKernelVersion === version,
      warning: patched ? '当前内核需通过兼容补丁启动（官方修复版发布前，部分 UI 特性暂缺）' : undefined
    }
  })
  ipcMain.handle('kernels:setMode', async (_e, mode: 'managed' | 'system') => {
    const cfg = configStore.set({ kernelMode: mode })
    rebuildMenu()
    if (dshManager.getState().status === 'running') {
      await dshManager.restart()
    }
    return { ok: cfg.kernelMode === mode }
  })
  ipcMain.handle('kernels:checkUpdate', () => kernelManager.checkUpdate())
  ipcMain.handle('kernels:quota', () => kernelManager.quota())

  // ---------- 内置 Node 运行时（阶段 B）----------
  ipcMain.handle('runtime:status', () => runtimeManager.status())
  ipcMain.handle('runtime:download', () => runtimeManager.download())
  ipcMain.handle('runtime:remove', () => runtimeManager.remove())

  // ---------- 配置档案（阶段 C：多 Profile + 内核版本绑定）----------
  ipcMain.handle('profiles:list', () => listProfiles())
  ipcMain.handle('profiles:create', (_e, name: string) => createProfile(name))
  ipcMain.handle('profiles:delete', (_e, id: string) => deleteProfile(id))
  ipcMain.handle('profiles:activate', async (_e, id: string) => {
    const r = activateProfile(id)
    if (r.ok && dshManager.getState().status === 'running') {
      await dshManager.restart()
    }
    return r
  })
  ipcMain.handle('profiles:setKernel', async (_e, id: string, version: string | null) => {
    // R-23: 绑定前校验目标内核已安装
    if (version !== null && !kernelManager.listInstalled().some((k) => k.version === version)) {
      return { ok: false, error: '内核 v' + version + ' 未安装，无法绑定' }
    }
    // R-24: 绑定「当前激活档案」的投递内核 → 试启动门禁（失败不生效；spawn 仍按注册表注入补丁）
    const bindingActive = configStore.get().activeProfileId === id
    if (bindingActive && version !== null && kernelManager.bootHealthOf(version) !== 'ok') {
      const dshHome = dshManager.resolveDshHome()
      const trial = await trialBootManagedKernel(version, dshHome, { timeoutMs: 60_000 })
      if (!trial.ok) {
        kernelManager.setBootHealth(version, 'failed', trial.error)
        return {
          ok: false,
          error: '内核 v' + version + ' 试启动失败：' + (trial.error ?? '未知错误') + '。绑定未生效，请先处理该内核启动问题。'
        }
      }
      kernelManager.setBootHealth(version, 'ok')
      kernelManager.setCompatPatch(version, trial.patchUsed ? compatPatchPathFor(version) : null)
    }
    const r = setProfileKernel(id, version)
    if (r.ok && configStore.get().activeProfileId === id && dshManager.getState().status === 'running') {
      await dshManager.restart()
    }
    return r
  })

  // ---------- 会话管理（P0：总览/会话页）----------
  ipcMain.handle('sessions:list', (_e, limit?: number) => listSessions(typeof limit === 'number' ? limit : undefined))
  ipcMain.handle('sessions:open', async (_e, uuid: string) => {
    if (!isSessionId(uuid)) return { ok: false, error: '非法会话 ID' }
    return openSession(uuid)
  })
  ipcMain.handle('sessions:remove', async (_e, uuid: string) => {
    if (!isSessionId(uuid)) return { ok: false, error: '非法会话 ID' }
    return removeSession(uuid)
  })
  ipcMain.handle('sessions:export', async (_e, uuid: string) => {
    if (!isSessionId(uuid)) return { ok: false, error: '非法会话 ID' }
    return exportSession(uuid)
  })
  ipcMain.handle('sessions:show', async (_e, uuid: string) => {
    if (!isSessionId(uuid)) return { ok: false, error: '非法会话 ID' }
    return showSessionInFolder(uuid)
  })

  // ---------- 通知（P0：设置页测试）----------
  ipcMain.handle('notify:test', () => {
    const ok = notify('DSH-Exoskeleton 测试通知', '通知设置已生效（系统通知）')
    return { ok }
  })

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
    rebuildMenu()
    return cfg
  })

  // ---------- 窗口 ----------
  ipcMain.handle('window:minimize', () => windowManager.getWindow()?.minimize())
  ipcMain.handle('window:toggleMaximize', () => windowManager.toggleMaximize())
  ipcMain.handle('window:close', () => windowManager.getWindow()?.hide())
  ipcMain.handle('window:isMaximized', () => windowManager.isMaximized())
  ipcMain.handle('window:setAdminPanelVisible', (_e, visible: boolean) => {
    windowManager.setAdminPanelVisible(visible === true)
  })

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
  ipcMain.handle('app:copyText', (_e, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
}
