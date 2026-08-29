/**
 * EmptyState —— 统一空状态（DESIGN.md：图标 + 一句话 + 引导动作）
 */
import type { ReactNode } from 'react'
import { IconInbox } from './icons'
import { Button } from './Button'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
  className?: string
}

export function EmptyState({ icon, title, hint, action, className = '' }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={`flex flex-col items-center px-8 py-9 text-center ${className}`}>
      <div className="mb-2.5 text-ink-3 opacity-60">{icon ?? <IconInbox size={30} />}</div>
      <div className="text-sm font-medium text-ink">{title}</div>
      {hint && <div className="mt-0.5 max-w-md text-xs text-ink-3">{hint}</div>}
      {action && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
