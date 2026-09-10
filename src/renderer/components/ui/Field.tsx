/**
 * Input / SearchInput / Select —— 表单原语
 * 状态：hover 提边 · focus 金描边+柔光环 · error 红色同构 · disabled 50%
 * 字体：数据类（端口/版本/密钥）默认等宽（mono）；名称、搜索等自然语言文本传 mono={false}
 */
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { IconSearch } from './icons'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: ReactNode
  /** 等宽字体（数据/密钥/端口…），默认 true；自然语言输入传 false */
  mono?: boolean
  /**
   * 宽度等布局类请写在这里（作用于外层容器）：flex 行里被压缩的是容器，
   * 若把宽度写在 className（= 内部 input）上，容器缩了而 input 保持定宽，
   * 就会横向溢出卡片（设置页 DSH Home 输入框曾因此画出边框）。
   */
  wrapperClassName?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, mono = true, className = '', wrapperClassName = '', ...rest },
  ref
): React.JSX.Element {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${wrapperClassName}`}>
      {label && <label className="text-xs text-ink-2">{label}</label>}
      <input
        ref={ref}
        className={`w-full min-w-0 rounded-control border bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:font-sans placeholder:text-ink-3 hover:border-rule-strong focus:border-accent/60 focus:ring-[3px] focus:ring-accent/15 disabled:opacity-50 ${
          mono ? 'font-mono' : 'font-sans'
        } ${error ? 'border-danger/60 focus:border-danger/60 focus:ring-danger/15' : 'border-rule'} ${className}`}
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

export interface SearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 作用于外层定位容器（宽度/外边距等），如 "w-56 ml-auto" */
  className?: string
}

/**
 * 带放大镜图标的搜索框（日志/插件/会话页共用）。
 * 各页原本各抄一份「relative 容器 + 绝对定位图标 + 裸 input」，样式与焦点环很快就飘了。
 */
export function SearchInput({ className = '', ...rest }: SearchInputProps): React.JSX.Element {
  return (
    <div className={`relative ${className}`}>
      <IconSearch
        size={13}
        className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-ink-3"
      />
      <Input mono={false} {...rest} className="pl-7" />
    </div>
  )
}

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
