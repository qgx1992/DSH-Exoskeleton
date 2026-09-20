/**
 * 主进程入口（文档 §4.1）
 * - 单实例运行（§4.1.4）
 * - 窗口 / 托盘 / IPC 初始化
 * - DSH 子进程自动启动与 WebContentsView 挂载
 */
import { app, Menu } from 'electron'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'
import { configStore } from './config'
import { windowManager } from './window-manager'
import { createTray, destroyTray, rebuildMenu } from './tray'
import { dshManager } from './dsh-manager'
import { registerIpcHandlers } from './ipc-handlers'
import { notificationHub } from './notification-hub'
import { provisionDefaultPlugins, reconcileInstalledBundles } from './plugins'
import { updater } from './updater'
import { kernelManager } from './kernel-manager'
import { runtimeManager } from './runtime-manager'
import { provisionDefaultKernel } from './kernel-provision'
import { sessionWatcher, wireSessionWatcher } from './session-watcher'
import { initNotificationProtocol, activateFromUrl } from './notify'
import { findSession } from './sessions'

const isHiddenLaunch = process.argv.includes('--hidden')

// 应用名必须早于 requestSingleInstanceLock 设置，才能决定 userData 目录
// （%APPDATA%\DSH-Exoskeleton：日志/配置存放处）
app.setName('DSH-Exoskeleton')
// 开发并行实例：DSH_DEV_USER_DATA 指向独立 userData，避免与已安装实例抢单实例锁
// （仅开发调试用；未设置时行为与原来完全一致）
const devUserData = process.env.DSH_DEV_USER_DATA
if (devUserData) {
  app.setPath('userData', devUserData)
}
// P0：AUMID 对齐 electron-builder.yml 的 appId —— Windows toast 要求与开始菜单快捷方式
// 一致，不一致会被系统静默丢弃（设计 NOTIFICATION-PLUGIN-DESIGN.md §4.3）
app.setAppUserModelId('io.dsh.exoskeleton')

// 单实例锁（文档 §4.1.4）
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    // 重复双击唤出已有窗口
    windowManager.show()
    // v0.8.2：原生 toast 协议激活（dsh-exo://）——弹出/操作中心点击都会拉起
    // 协议 → 新进程转发 argv → 这里处理（唤起窗口 + 回放原点击动作/定位会话）
    handleProtocolLaunch(commandLine)
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

  // 移除 Electron 默认应用菜单（File / Edit / View / Window / Help）：
  // 带 frame 的窗口会把它画成顶部菜单栏，与「无标题栏」设计冲突；
  // 实测：不设这一句时 Menu.getApplicationMenu() 返回这 5 项，
  // 且 frame:true 窗口的「窗口高-内容高」为 39px（即被菜单栏占掉一条）。
  // 壳自己的功能入口在托盘菜单与管理面板，不依赖应用菜单。
  Menu.setApplicationMenu(null)

  logger.init()
  configStore.init()
  kernelManager.init()
  // 启动对账：修正「卸载/安装被中断」留下的脏账（installed 但 bin.js 已丢 → 标 broken；
  // 安装残留 → 标 broken 供卸载；目录已不在 → 清索引），并重测 broken 项占用。
  // 必须在任何 listInstalled()（如预置判断、面板首次拉取）之前跑，否则脏项会被当作不可见泄漏。
  kernelManager.reconcile()
  // 回收上一次卸载留下的 .deleting 目录（当时文件被运行中的内核进程映射，删不掉）：
  // 此刻上一个进程已退出，占用通常已释放，这一轮往往能真正把磁盘收回。
  kernelManager.purgeTrash()
  runtimeManager.init()

  // v0.8.2：注册 dsh-exo:// 协议（原生 toast 协议激活的前置；幂等，每次启动重设）
  initNotificationProtocol()

  // 内核安装进度 → 渲染层
  kernelManager.on('progress', (p) => {
    windowManager.broadcast('kernels:progress', p)
  })
  // 内置 Node 运行时下载/解压进度 → 渲染层
  runtimeManager.on('progress', (p) => {
    windowManager.broadcast('runtime:progress', p)
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
      // H5: 优先使用 dsh web 打印的完整 URL（alpha 内核含 ?token=…，首次访问签发 cookie 后才能进 UI）
      windowManager.attachDshView(dshManager.getWebUrl() ?? `http://127.0.0.1:${state.port}`)
      // 内置默认插件预置（幂等，仅首次执行；不阻塞 UI）
      void provisionDefaultPlugins()
      // 历史欠账修复：IGNORED_BUILDS 时代 `dsh plugin add` exit 1 中断的 bundle reconcile 补上
      // （幂等：已注册的跳过；不阻塞 UI）
      void reconcileInstalledBundles()
    } else if (state.status === 'error' || state.status === 'stopped') {
      windowManager.detachDshView()
    }
    // 会话观察与 DSH 服务状态联动
    sessionWatcher.syncWithService(state.status)
    rebuildMenu()

    // 服务事件通知（设计 §4.2：只改投递目标，检测/门控逻辑不变——hub 负责渠道路由）
    if (configStore.get().notifyServiceEvents) {
      const winVisible = windowManager.getWindow()?.isVisible() ?? false
      if (state.status === 'running' && state.port) {
        if (!winVisible) {
          notificationHub.dispatch({
            id: randomUUID(),
            kind: 'service-ready',
            title: 'DSH-Exoskeleton 服务已就绪',
            body: `DSH Web UI 运行于 http://127.0.0.1:${state.port}`,
            ts: Date.now(),
            service: { port: state.port },
            actions: { onClick: () => windowManager.show() }
          })
        }
      } else if (state.status === 'error') {
        notificationHub.dispatch({
          id: randomUUID(),
          kind: 'service-error',
          title: 'DSH 服务异常',
          body: state.lastError ?? '未知错误，请查看日志',
          ts: Date.now(),
          service: { error: state.lastError ?? undefined },
          actions: { onClick: () => windowManager.show() }
        })
      } else if (state.status === 'starting' && state.restartCount > 0) {
        notificationHub.dispatch({
          id: randomUUID(),
          kind: 'service-restarting',
          title: `DSH 服务正在重启（第 ${state.restartCount} 次）`,
          body: '检测到进程异常退出，正在自动恢复…',
          ts: Date.now(),
          service: { restartCount: state.restartCount }
        })
      }
    }
  })

  // 获取内核版本（异步，不阻塞）
  void dshManager.readVersion().then(() => {
    windowManager.broadcast('dsh:statusChange', dshManager.getState())
  })

  // 自动更新：初始化并向渲染层推送状态（打包版后台静默检查）
  updater.init()
  // P2 review 修正：webview 通道的「更新就绪」toast 点击 → notify:install → 触发安装
  notificationHub.setOnInstall(() => updater.install())
  updater.on('status', (info) => {
    windowManager.broadcast('updater:status', info)
  })
  if (app.isPackaged) {
    // 启动后台静默检查；config.autoCheckUpdate=false 时不发请求（checkIfAutoEnabled 内部判断）
    setTimeout(() => updater.checkIfAutoEnabled(), 15_000)
  }

  // 自动启动 DSH 服务
  if (cfg.autoStartService !== false) {
    void dshManager.start()
  }

  // 阶段 D：首启默认内核预置（全新安装自动装 DEFAULT_KERNEL_VERSION 并切换；
  // 不阻塞首屏，安装期间服务可先用系统 dsh 兜底，完成后自动重启换内核）
  void provisionDefaultKernel()

  if (isHiddenLaunch) {
    windowManager.hide()
  }

  // v0.8.2：冷启动协议激活（应用未运行时点击操作中心里的 toast → Windows 带
  // dsh-exo:// URL 拉起本应用）——放最后，确保窗口/视图就绪后再定位会话
  handleProtocolLaunch(process.argv)
}

/**
 * 处理 dsh-exo:// 协议激活（原生 toast 点击的统一入口）。
 * - 命中通知注册表（应用运行中、未过期）：原点击动作（唤起/定位/安装）已由
 *   activateFromUrl 执行，直接返回；
 * - 未命中（冷启动 / 注册表已过期）：兜底唤起窗口 + 按 kind 处理
 *   （session-done → 定位会话；update-ready → 触发安装）。
 */
function handleProtocolLaunch(argv: string[]): void {
  const url = argv.find((a) => typeof a === 'string' && a.startsWith('dsh-exo:'))
  if (!url) return
  const { handled, payload } = activateFromUrl(url)
  if (handled) return
  windowManager.show()
  if (payload?.kind === 'update-ready') {
    updater.install()
    return
  }
  if (payload?.session) {
    void activateSessionFromProtocol(payload.session)
  }
}

/** 冷启动协议激活：等待 DSH 视图挂载后定位会话（最多 ~15s） */
async function activateSessionFromProtocol(uuid: string): Promise<void> {
  for (let i = 0; i < 15; i++) {
    // 优先走 webview 插件程序化激活（可靠、会话 ID 精确）
    if (notificationHub.requestActivate(uuid)) return
    // 视图就绪后走 DOM 兜底（readId + 标题/时间多候补）
    if (windowManager.getViewUrl()) {
      try {
        const s = await findSession(uuid)
        windowManager.activateSessionInWebUi(
          s?.title ?? `会话 ${uuid.slice(0, 8)}`,
          s?.firstUserText,
          uuid
        )
      } catch (err) {
        logger.warn('protocol session activate failed', err)
        windowManager.activateSessionInWebUi(`会话 ${uuid.slice(0, 8)}`, undefined, uuid)
      }
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  logger.debug('protocol activation: view not ready within 15s, skip session jump', { uuid })
}

// 托盘常驻：窗口全部关闭时不退出（文档 §4.1.3 "程序常驻后台"）
app.on('window-all-closed', () => {
  /* 保留在托盘，不退出 */
})

app.on('before-quit', () => {
  windowManager.quit()
})

app.on('will-quit', () => {
  // R-2: 同步强杀 dsh 进程树（Electron 不等 will-quit 中的异步，避免孙进程/端口残留）
  dshManager.killTreeNow()
  destroyTray()
})
