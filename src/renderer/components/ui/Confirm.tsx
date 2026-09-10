/**
 * ConfirmProvider / useConfirm —— 应用内确认弹窗（替代 window.confirm）
 * 用法：const confirm = useConfirm()
 *      if (!(await confirm({ title: '删除会话？', body: '...', danger: true }))) return
 * 相比 window.confirm：黑金主题一致、不阻塞渲染、支持多行说明；
 * 危险操作默认聚焦「取消」，避免连按回车误触。
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'

export interface ConfirmOptions {
  title: string
  /** 说明文本（\n 保留换行） */
  body?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作：确认键红实底 + 默认焦点落在取消 */
  danger?: boolean
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext)
  if (!fn) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用')
  return fn
}

export function ConfirmProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  /** 未决确认的 resolver；新确认到来时把旧的按「取消」结清，避免 promise 永久悬挂 */
  const resolverRef = useRef<((v: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((next) => {
    resolverRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
      setOpts(next)
    })
  }, [])

  const settle = useCallback((value: boolean) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setOpts(null)
    resolve?.(value)
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={opts !== null}
        onClose={() => settle(false)}
        title={opts?.title ?? ''}
        footer={
          <>
            <Button
              variant="secondary"
              data-autofocus={opts?.danger ? 'true' : undefined}
              onClick={() => settle(false)}
            >
              {opts?.cancelText ?? '取消'}
            </Button>
            <Button
              variant={opts?.danger ? 'danger-solid' : 'primary'}
              data-autofocus={opts?.danger ? undefined : 'true'}
              onClick={() => settle(true)}
            >
              {opts?.confirmText ?? '确认'}
            </Button>
          </>
        }
      >
        {opts?.body && <p className="whitespace-pre-wrap">{opts.body}</p>}
      </Modal>
    </ConfirmContext.Provider>
  )
}
