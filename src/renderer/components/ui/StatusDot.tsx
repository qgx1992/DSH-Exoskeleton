/**
 * StatusDot —— 服务状态点（DESIGN.md：运行中=success 呼吸光点，启动中=info ping，停止=灰，异常=danger）
 */
import type { DSHStatus } from '../../../shared/types'

export function StatusDot({ status, className = '' }: { status: DSHStatus; className?: string }): React.JSX.Element {
  if (status === 'starting') {
    return (
      <span className={`relative flex size-2 shrink-0 ${className}`}>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-info" />
      </span>
    )
  }
  const cls = status === 'running' ? 'bg-success' : status === 'error' ? 'bg-danger' : 'bg-ink-3'
  const halo =
    status === 'running'
      ? '0 0 0 4px color-mix(in oklab, var(--color-success) 14%, transparent)'
      : status === 'error'
        ? '0 0 0 4px color-mix(in oklab, var(--color-danger) 15%, transparent)'
        : 'none'
  return <span className={`inline-block size-2 shrink-0 rounded-full ${cls} ${className}`} style={{ boxShadow: halo }} />
}
