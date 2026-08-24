/**
 * 原生通知（文档 §4.2.3）
 * - 服务就绪 / 服务异常 / 崩溃重启 等场景发送 Windows 原生通知
 * - 系统不支持时自动降级为托盘气泡
 */
import { Notification } from 'electron'
import { logger } from './logger'

export function notify(title: string, body: string, onClick?: () => void): void {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: false })
      if (onClick) n.on('click', onClick)
      n.show()
      logger.debug('notification sent', { title })
    } else {
      // 降级：托盘气泡（仅 macOS 支持 setTitle；Windows 下通过 balloon？）
      const { getTray } = require('./tray') as typeof import('./tray')
      const tray = getTray()
      if (tray) {
        tray.displayBalloon({ title, content: body.slice(0, 255) })
      }
    }
  } catch (err) {
    logger.warn('notification failed', err)
  }
}

export { Notification }