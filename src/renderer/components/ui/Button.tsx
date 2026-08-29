/**
 * Button —— 唯一按钮原语（DESIGN.md CTA voice）
 * 变体：primary 金实底 / secondary 次级 / ghost 幽灵 / danger 红 ghost / success 绿 ghost / accent 金软底
 * 状态：default / hover / focus-visible(全局环) / active 下沉 1px / disabled 40% / loading 内联转圈
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { IconSpinner } from './icons'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'accent'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  loading?: boolean
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-accent-ink hover:bg-accent-hover',
  secondary: 'border-rule bg-surface-2 text-ink hover:border-rule-strong',
  ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-white/5 hover:text-ink',
  danger: 'border-transparent bg-transparent text-danger hover:bg-danger/10',
  success: 'border-transparent bg-transparent text-success hover:bg-success/10',
  accent: 'border-transparent bg-accent/15 text-accent hover:bg-accent/25'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, disabled, className = '', children, type, ...rest },
  ref
): React.JSX.Element {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control border font-medium transition-all duration-150 ease-hallmark active:translate-y-px disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-40 ${
        size === 'sm' ? 'px-2.5 py-[5px] text-xs' : 'px-3.5 py-[7px] text-sm'
      } ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading && <IconSpinner size={12} />}
      {children}
    </button>
  )
})
