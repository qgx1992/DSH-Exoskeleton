/**
 * Toggle —— 开关（DESIGN.md：transform 位移合成层动画，不动 left）
 * 状态：off / on / hover（轨道提边）/ focus-visible(全局环) / disabled
 */
interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  'aria-label'?: string
}

export function Toggle({ checked, onChange, disabled, 'aria-label': ariaLabel }: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-chip border transition-colors duration-200 ease-hallmark ${
        checked ? 'border-accent bg-accent hover:bg-accent-hover' : 'border-rule-strong bg-surface-2 hover:border-ink-3'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <span
        className={`absolute left-[2px] top-[2px] h-[14px] w-[14px] rounded-full transition-transform duration-200 ease-hallmark ${
          checked ? 'translate-x-4 bg-accent-ink' : 'bg-ink-2'
        }`}
      />
    </button>
  )
}
