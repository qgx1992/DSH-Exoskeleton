/**
 * Card / CardHead / Row / Notice —— 版面原语
 * Card：surface 底 + rule 边 + 12px 圆角（替代散落的 bg-[#0d111a] section）
 * Row：卡片内的行条目（canvas 半透底，微内陷）
 * Notice：ok/err 结果横幅
 */
import type { ReactNode } from 'react'

export function Card({ className = '', children }: { className?: string; children: ReactNode }): React.JSX.Element {
  return <section className={`rounded-card border border-rule bg-surface p-5 ${className}`}>{children}</section>
}

export function CardHead({
  title,
  right,
  className = ''
}: {
  title: ReactNode
  right?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between gap-3 ${className}`}>
      <h3 className="text-xs font-semibold tracking-wider text-ink-2">{title}</h3>
      {right}
    </div>
  )
}

export function Row({ className = '', children }: { className?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className={`flex items-center gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2 ${className}`}>
      {children}
    </div>
  )
}

export function Notice({ tone, children }: { tone: 'ok' | 'err'; children: ReactNode }): React.JSX.Element {
  return (
    <div
      className={`rounded-control border px-3 py-2 text-xs ${
        tone === 'ok' ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger'
      }`}
    >
      {children}
    </div>
  )
}
