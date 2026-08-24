import { useEffect, useRef, useState } from 'react'
import type { LogEntry } from '../../../shared/types'

export function LogsTab(): React.JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      void window.dshDesktop.logs.list(300).then(setLogs)
    }
    refresh()
    timerRef.current = window.setInterval(refresh, 1500)
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [])

  const levelColor: Record<LogEntry['level'], string> = {
    debug: 'text-slate-500',
    info: 'text-slate-300',
    warn: 'text-amber-400',
    error: 'text-red-400'
  }

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
        {logs.length === 0 && <div className="text-slate-600">暂无日志</div>}
        {logs.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            <span className="text-slate-600">[{new Date(l.time).toLocaleTimeString()}]</span>{' '}
            <span className={levelColor[l.level]}>[{l.level.toUpperCase()}]</span>{' '}
            <span className={levelColor[l.level]}>{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}