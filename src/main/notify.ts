/**
 * 原生通知（文档 §4.2.3）
 * - 服务就绪 / 服务异常 / 崩溃重启 等场景发送 Windows 原生通知
 * - 系统不支持时自动降级为托盘气泡
 * - 返回 boolean：是否真正送达某通道（P3 review 修正：native 投递回执不再恒为 true，
 *   notification-hub 的 R-26「漏报可查」对原生通道才真实）
 */
import { Notification } from 'electron'
import { logger } from './logger'

export function notify(title: string, body: string, onClick?: () => void): boolean {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: false })
      if (onClick) n.on('click', onClick)
      n.show()
      logger.debug('notification sent', { title })
      return true
    } else {
      // 降级：托盘气泡
      const { getTray } = require('./tray') as typeof import('./tray')
      const tray = getTray()
      if (tray) {
        tray.displayBalloon({ title, content: body.slice(0, 255) })
        return true
      }
      return false
    }
  } catch (err) {
    logger.warn('notification failed', err)
    return false
  }
}

export { Notification }
