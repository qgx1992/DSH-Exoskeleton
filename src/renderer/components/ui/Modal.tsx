/**
 * Modal —— 应用内弹层原语（DESIGN.md：遮罩 overlay-in + 内容 modal-in，圆角 rounded-card）
 * 统一处理：Esc 关闭 / 遮罩点击关闭 / 焦点锁在弹层内 / 关闭后焦点归还触发元素。
 * 用途：替代 window.confirm（系统亮色、无主题、阻塞渲染）以及各处的自绘遮罩。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { IconX } from './icons'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ModalProps {
  open: boolean
  onClose: () => void
  /** 标题（同时作为 aria-label） */
  title: string
  children?: ReactNode
  /** 底部按钮区（右对齐） */
  footer?: ReactNode
  /** 弹层宽度类（默认 max-w-md） */
  className?: string
  /** 右上角关闭按钮（默认显示） */
  closable?: boolean
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className = 'max-w-md',
  closable = true
}: ModalProps): React.JSX.Element | null {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  /** onClose 走 ref：父组件每次渲染传入内联箭头函数时不会重跑副作用（否则焦点反复跳） */
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const box = boxRef.current
      if (!box) return
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      // 焦点锁：Tab 到边界时回卷，键盘不会跑到弹层外的面板上
      if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (active === first || !box.contains(active))) {
        e.preventDefault()
        last.focus()
      }
    }
    // 捕获阶段监听：弹层打开时优先于面板内的快捷键
    window.addEventListener('keydown', onKey, true)
    const t = window.setTimeout(() => {
      const box = boxRef.current
      if (!box) return
      const el = box.querySelector<HTMLElement>('[data-autofocus]') ?? box.querySelector<HTMLElement>(FOCUSABLE)
      el?.focus()
    }, 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey, true)
      restoreRef.current?.focus?.()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal-in w-full ${className} rounded-card border border-rule bg-surface p-5 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {closable && (
            <button
              onClick={onClose}
              aria-label="关闭"
              className="-m-1 rounded-control p-1 text-ink-3 transition-colors duration-150 hover:bg-white/5 hover:text-ink"
            >
              <IconX size={16} />
            </button>
          )}
        </div>
        {children && <div className="mt-3 text-xs leading-relaxed text-ink-2">{children}</div>}
        {footer && <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}
