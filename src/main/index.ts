/**
 * 主进程入口（文档 §4.1）
 * - 单实例运行（§4.1.4）
 * - 窗口 / 托盘 / IPC 初始化
 * - DSH 子进程自动启动与 WebContentsView 挂载
 */
import { app } from 'electron'
import { logger } from './logger'
import { configStore } from './config'
import { windowManager } from './window-manager'
import { createTray, destroyTray, rebuildMenu } from './tray'
import { dshManager } from './dsh-manager'
import { registerIpcHandlers } from './ipc-handlers'
import { notify } from './notify'
import { updater } from './updater'
import { kernelManager } from './kernel-manager'
import { sessionWatcher, wireSessionWatcher } from './session-watcher'

const isHiddenLaunch = process.argv.includes('--hidden')

// 应用名必须早于 requestSingleInstanceLock 设置，才能决定 userData 目录
// （%APPDATA%\DSH-Exoskeleton：日志/配置存放处）
app.setName('DSH-Exoskeleton')
app.setAppUserModelId('io.dsh.desktop')

// 单实例锁（文档 §4.1.4）
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 重复双击唤出已有窗口
    windowManager.show()
  })

  void bootstrap()
}

async function bootstrap(): Promise<void> {
  // 全局异常捕获
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', err.message)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', String(reason))
  })

  await app.whenReady()

  logger.init()
  configStore.init()
  kernelManager.init()

  // 内核安装进度 → 渲染层
  kernelManager.on('progress', (p) => {
    windowManager.broadcast('kernels:progress', p)
  })

  // 会话完成通知（§4.2.3）
  wireSessionWatcher()

  // 开机自启状态与配置同步
  const cfg = configStore.get()
  const loginSettings = app.getLoginItemSettings()
  if (loginSettings.openAtLogin !== cfg.autoLaunch) {
    const synced = { ...cfg, autoLaunch: loginSettings.openAtLogin }
    void configStore.set(synced)
  }

  registerIpcHandlers()
  createTray()
  windowManager.create()

  // 状态变化：running → 挂载 DSH Web UI；error/stopped → 卸载
  dshManager.on('statusChange', (state) => {
    if (state.status === 'running' && state.port) {
      windowManager.attachDshView(`http://127.0.0.1:${state.port}`)
    } else if (state.status === 'error' || state.status === 'stopped') {
      windowManager.detachDshView()
    }
    // 会话观察与 DSH 服务状态联动
    sessionWatcher.syncWithService(state.status)
    rebuildMenu()

    // 原生通知（文档 §4.2.3）：就绪仅窗口隐藏时提示；异常总是提示
    if (configStore.get().notifyServiceEvents) {
      const winVisible = windowManager.getWindow()?.isVisible() ?? false
      if (state.status === 'running' && state.port) {
        if (!winVisible) {
          notify(
            'DSH-Exoskeleton 服务已就绪',
            `DSH Web UI 运行于 http://127.0.0.1:${state.port}`,
            () => windowManager.show()
          )
        }
      } else if (state.status === 'error') {
        notify('DSH 服务异常', state.lastError ?? '未知错误，请查看日志', () => windowManager.show())
      } else if (state.status === 'starting' && state.restartCount > 0) {
        notify(`DSH 服务正在重启（第 ${state.restartCount} 次）`, '检测到进程异常退出，正在自动恢复…')
      }
    }
  })

  // 获取内核版本（异步，不阻塞）
  void dshManager.readVersion().then(() => {
    windowManager.broadcast('dsh:statusChange', dshManager.getState())
  })

  // 自动更新：初始化并向渲染层推送状态（打包版后台静默检查）
  updater.init()
  updater.on('status', (info) => {
    windowManager.broadcast('updater:status', info)
  })
  if (app.isPackaged) {
    setTimeout(() => void updater.check().catch(() => logger.warn('background update check failed')), 15_000)
  }

  // 自动启动 DSH 服务
  if (cfg.autoStartService !== false) {
    void dshManager.start()
  }

  if (isHiddenLaunch) {
    windowManager.hide()
  }
}

// 托盘常驻：窗口全部关闭时不退出（文档 §4.1.3 "程序常驻后台"）
app.on('window-all-closed', () => {
  /* 保留在托盘，不退出 */
})

app.on('before-quit', () => {
  windowManager.quit()
})

app.on('will-quit', () => {
  void dshManager.shutdown().finally(() => destroyTray())
})