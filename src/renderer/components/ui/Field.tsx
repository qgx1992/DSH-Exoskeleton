/**
 * Input / Select —— 表单原语（DESIGN.md：数字与密钥等宽字体）
 * 状态：hover 提边 · focus 金描边+柔光环 · error 红色同构 · disabled 50%
 */
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, className = '', ...rest },
  ref
): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label && <label className="text-xs text-ink-2">{label}</label>}
      <input
        ref={ref}
        className={`min-w-0 rounded-control border bg-surface-2 px-2.5 py-1.5 font-mono text-sm text-ink outline-none transition-colors duration-150 placeholder:font-sans placeholder:text-ink-3 hover:border-rule-strong focus:border-accent/60 focus:ring-[3px] focus:ring-accent/15 disabled:opacity-50 ${
          error ? 'border-danger/60 focus:border-danger/60 focus:ring-danger/15' : 'border-rule'
        } ${className}`}
        {...rest}
      />
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="text-xs text-ink-3">{hint}</span>
      ) : null}
    </div>
  )
})

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  className?: string
  children: ReactNode
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className = '', children, ...rest },
  ref
): React.JSX.Element {
  return (
    <select
      ref={ref}
      className={`min-w-0 rounded-control border border-rule bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors duration-150 hover:border-rule-strong focus:border-accent/60 focus:ring-[3px] focus:ring-accent/15 disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </select>
  )
})
