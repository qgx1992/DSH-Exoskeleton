import type { DSHStatus } from '../../shared/types'
import { WhaleIcon } from './WhaleIcon'
import { StatusDot } from './ui/StatusDot'
import { IconGlobe, IconSettings } from './ui/icons'

interface Props {
  status: DSHStatus
  port: number | null
  version: string | null
  appVersion: string
  maximized: boolean
  /** 管理面板是否打开（打开时隐藏 DSH Web UI 视图） */
  adminPanel: boolean
  /** 切换管理面板显隐 */
  onToggleAdminPanel: () => void
  /** 「网页版 DeepSeek」是否激活（管理面板打开且落在网页版标签） */
  webPanel: boolean
  /** 切换网页版 DeepSeek 显隐 */
  onToggleWebPanel: () => void
}

const STATUS_LABEL: Record<DSHStatus, string> = {
  running: '服务运行中',
  starting: '服务启动中',
  stopped: '服务已停止',
  error: '服务异常'
}

export function TitleBar({ status, port, version, appVersion, maximized, adminPanel, onToggleAdminPanel, webPanel, onToggleWebPanel }: Props): React.JSX.Element {
  return (
    // 窗口控制按钮贴右缘（Win11 惯例），故只用左内边距
    <header className="titlebar-drag flex h-9 shrink-0 items-center gap-3 border-b border-rule bg-surface pl-3">
      {/* 品牌 */}
      <div className="flex items-center gap-2">
        <WhaleIcon size={16} />
        <span className="text-sm font-semibold tracking-wide text-ink">DSH-Exoskeleton</span>
        <span className="rounded bg-surface-2 px-1.5 py-px font-mono text-2xs text-ink-2">v{appVersion || '-'}</span>
      </div>

      {/* 状态指示 */}
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <StatusDot status={status} />
        <span className="text-ink">{STATUS_LABEL[status] ?? STATUS_LABEL.starting}</span>
        {port && <span className="rounded bg-info/10 px-1.5 py-px font-mono text-2xs text-info">127.0.0.1:{port}</span>}
        {version && <span className="hidden font-mono text-2xs text-ink-3 md:inline">dsh {version}</span>}
      </div>

      <div className="flex-1" />

      {/* 窗口控制按钮（Win11 风格：全高、贴角、hover 微圆角；关闭键 hover 红实底） */}
      <div className="titlebar-no-drag flex h-full items-center">
        {/* 「网页版 DeepSeek」入口：放在「打开管理面板」按钮左边；激活态高亮（管理面板打开且落在网页版标签） */}
        <button
          className={webPanel ? 'flex h-full w-11 items-center justify-center rounded-t-[4px] transition-colors duration-150 bg-accent/15 text-accent hover:bg-accent/25' : 'flex h-full w-11 items-center justify-center rounded-t-[4px] transition-colors duration-150 text-ink-2 hover:bg-white/5 hover:text-ink active:bg-white/10'}
          title={webPanel ? '关闭网页版 DeepSeek' : '打开网页版 DeepSeek'}
          onClick={onToggleWebPanel}
        >
          <IconGlobe size={14} strokeWidth={2} />
        </button>
        <button
          className={`flex h-full w-11 items-center justify-center rounded-t-[4px] transition-colors duration-150 ${
            adminPanel ? 'bg-accent/15 text-accent hover:bg-accent/25' : 'text-ink-2 hover:bg-white/5 hover:text-ink active:bg-white/10'
          }`}
          title={adminPanel ? '关闭管理面板' : '打开管理面板'}
          onClick={onToggleAdminPanel}
        >
          <IconSettings size={14} strokeWidth={2} />
        </button>
        <button
          className="flex h-full w-11 items-center justify-center rounded-t-[4px] text-ink-2 transition-colors duration-150 hover:bg-white/5 hover:text-ink active:bg-white/10"
          title="最小化"
          onClick={() => void window.dshDesktop.window.minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          className="flex h-full w-11 items-center justify-center rounded-t-[4px] text-ink-2 transition-colors duration-150 hover:bg-white/5 hover:text-ink active:bg-white/10"
          title={maximized ? '还原' : '最大化'}
          onClick={() => void window.dshDesktop.window.toggleMaximize()}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1.2" />
              <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </button>
        <button
          className="flex h-full w-11 items-center justify-center rounded-t-[4px] text-ink-2 transition-colors duration-150 hover:bg-danger hover:text-ink active:bg-danger/80"
          title="关闭（隐藏到托盘）"
          onClick={() => void window.dshDesktop.window.close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </header>
  )
}
