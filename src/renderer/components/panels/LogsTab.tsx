import { useEffect, useRef, useState } from 'react'
import type { LogEntry } from '../../../shared/types'

/** 显示上限（截断旧日志，控制 DOM 规模） */
const DISPLAY_LIMIT = 200

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  debug: 'text-slate-500',
  info: 'text-slate-300',
  warn: 'text-amber-400',
  error: 'text-red-400'
}

export function LogsTab(): React.JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const timerRef = useRef<number | null>(null)
  /** R-5: 竞态防护——只接受最新一次请求的响应（丢弃乱序旧响应） */
  const reqRef = useRef(0)

  useEffect(() => {
    const refresh = (): void => {
      const id = ++reqRef.current
      void window.dshDesktop.logs.list(300).then((next) => {
        if (id === reqRef.current) setLogs(next)
      })
    }
    refresh()
    // R-5: 窗口隐藏（托盘常驻）时暂停轮询，节省 IPC 与渲染
    const onVisibility = (): void => {
      if (document.hidden) {
        if (timerRef.current !== null) {
          window.clearInterval(timerRef.current)
          timerRef.current = null
        }
      } else if (timerRef.current === null) {
        refresh()
        timerRef.current = window.setInterval(refresh, 1500)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    timerRef.current = window.setInterval(refresh, 1500)
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // R-5: 只渲染最近 DISPLAY_LIMIT 条（截断旧日志，控制 DOM 规模）
  const visible = logs.slice(-DISPLAY_LIMIT)

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-100">运行日志</h2>
        <button
          onClick={() => void window.dshDesktop.logs.openDir()}
          className="rounded-lg bg-slate-800 px-3 py-1 text-[12px] text-slate-300 hover:bg-slate-700"
        >
          打开日志目录
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-800 bg-[#0a0e15] p-3 font-mono text-[12px] leading-relaxed">
        {visible.length === 0 && <div className="text-slate-600">暂无日志</div>}
        {visible.map((l, i) => (
          <div key={l.time + '-' + i} className="whitespace-pre-wrap break-all">
            <span className="text-slate-600">[{new Date(l.time).toLocaleTimeString()}]</span>{' '}
            <span className={LEVEL_COLOR[l.level]}>[{l.level.toUpperCase()}]</span>{' '}
            <span className={LEVEL_COLOR[l.level]}>{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
