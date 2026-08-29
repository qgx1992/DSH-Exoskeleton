/**
 * Badge —— 语义徽标（DESIGN.md：cyan=默认/信息 · amber=待办 · green=成功 · red=危险 · gray=中性）
 */
import type { ReactNode } from 'react'

export type BadgeTone = 'cyan' | 'amber' | 'red' | 'green' | 'gray'

const TONES: Record<BadgeTone, string> = {
  cyan: 'border-info/30 bg-info/10 text-info',
  amber: 'border-warning/30 bg-warning/10 text-warning',
  red: 'border-danger/30 bg-danger/10 text-danger',
  green: 'border-success/30 bg-success/10 text-success',
  gray: 'border-rule bg-surface-2 text-ink-2'
}

export function Badge({
  tone = 'gray',
  className = '',
  children
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-chip border px-2 py-px font-mono text-2xs ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}
