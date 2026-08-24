import type { DSHStatus } from '../../shared/types'
import { WhaleIcon } from './WhaleIcon'

interface Props {
  status: DSHStatus
  port: number | null
  version: string | null
  appVersion: string
  maximized: boolean
}

const STATUS_META: Record<DSHStatus, { label: string; color: string; pulse?: boolean }> = {
  running: { label: '服务运行中', color: '#22d3ee', pulse: true },
  starting: { label: '服务启动中', color: '#9ca3af', pulse: true },
  stopped: { label: '服务已停止', color: '#6b7280' },
  error: { label: '服务异常', color: '#ef4444' }
}

export function TitleBar({ status, port, version, appVersion, maximized }: Props): React.JSX.Element {
  const meta = STATUS_META[status] ?? STATUS_META.starting
  return (
    <header className="titlebar-drag flex h-9 shrink-0 items-center gap-3 border-b border-slate-800 bg-[#0d111a] px-3">
      {/* 品牌 */}
      <div className="flex items-center gap-2">
        <WhaleIcon size={16} />
        <span className="text-[13px] font-semibold tracking-wide text-slate-100">
          DSH-Exoskeleton
        </span>
        <span className="rounded bg-slate-800 px-1.5 py-px text-[10px] text-slate-400">
          v{appVersion || '-'}
        </span>
      </div>

      {/* 状态指示 */}
      <div className="flex items-center gap-2 text-[12px] text-slate-400">
        <span className="relative flex h-2 w-2">
          {meta.pulse && (
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
              style={{ backgroundColor: meta.color }}
            />
          )}
          <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: meta.color }} />
        </span>
        <span className="text-slate-300">{meta.label}</span>
        {port && <span className="rounded bg-slate-800/80 px-1.5 py-px font-mono text-[11px] text-cyan-300">127.0.0.1:{port}</span>}
        {version && <span className="hidden font-mono text-[11px] text-slate-500 md:inline">dsh {version}</span>}
      </div>

      <div className="flex-1" />

      {/* 窗口控制按钮（圆角 hover 背景，Windows 11 风格） */}
      <div className="titlebar-no-drag flex items-center">
        <button
          className="flex h-7 w-11 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-slate-100 active:bg-white/[0.14]"
          title="最小化"
          onClick={() => void window.dshDesktop.window.minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          className="flex h-7 w-11 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-slate-100 active:bg-white/[0.14]"
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
          className="flex h-7 w-11 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-500/90 hover:text-white active:bg-red-600"
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