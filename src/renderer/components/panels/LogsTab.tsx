import { useEffect, useRef, useState } from 'react'
import type { LogEntry } from '../../../shared/types'
import { Button } from '../ui/Button'
import { IconSearch } from '../ui/icons'

/** 显示上限（截断旧日志，控制 DOM 规模） */
const DISPLAY_LIMIT = 200

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  debug: 'text-ink-3',
  info: 'text-ink-2',
  warn: 'text-warning',
  error: 'text-danger'
}

type LevelFilter = 'all' | LogEntry['level']

const FILTERS: { id: LevelFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'info', label: 'INFO' },
  { id: 'warn', label: 'WARN' },
  { id: 'error', label: 'ERROR' }
]

export function LogsTab(): React.JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [query, setQuery] = useState('')
  /** 自动吸底跟随：用户向上滚动即暂停，滚回底部恢复 */
  const [follow, setFollow] = useState(true)
  const boxRef = useRef<HTMLDivElement | null>(null)
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

  const q = query.trim().toLowerCase()
  const filtered = visible.filter(
    (l) => (levelFilter === 'all' || l.level === levelFilter) && (!q || l.message.toLowerCase().includes(q))
  )

  // 新日志吸底（用户上滚暂停时不动）
  useEffect(() => {
    const box = boxRef.current
    if (box && follow) box.scrollTop = box.scrollHeight
  }, [filtered, follow])

  const onScroll = (): void => {
    const box = boxRef.current
    if (!box) return
    setFollow(box.scrollTop + box.clientHeight >= box.scrollHeight - 24)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink">运行日志</h2>
        <Button variant="secondary" size="sm" onClick={() => void window.dshDesktop.logs.openDir()}>
          打开日志目录
        </Button>
      </div>

      {/* 过滤工具条 */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setLevelFilter(f.id)}
            className={`rounded-chip border px-2.5 py-0.5 font-mono text-2xs transition-colors duration-150 ${
              levelFilter === f.id
                ? 'border-accent/35 bg-accent/12 text-accent'
                : 'border-rule text-ink-2 hover:border-rule-strong hover:text-ink'
            }`}
          >
            {f.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <IconSearch size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索日志…"
            className="w-56 rounded-control border border-rule bg-surface-2 py-1 pl-7 pr-2 text-xs text-ink outline-none transition-colors duration-150 placeholder:text-ink-3 hover:border-rule-strong focus:border-accent/60"
          />
        </div>
      </div>

      {/* 日志区：可选中复制 */}
      <div
        ref={boxRef}
        onScroll={onScroll}
        className="selectable min-h-0 flex-1 overflow-y-auto rounded-card border border-rule bg-canvas p-3 font-mono text-xs leading-relaxed"
      >
        {filtered.length === 0 && (
          <div className="text-ink-3">{visible.length === 0 ? '暂无日志' : '没有匹配的日志'}</div>
        )}
        {filtered.map((l, i) => (
          <div key={l.time + '-' + i} className="whitespace-pre-wrap break-all">
            <span className="text-ink-3">[{new Date(l.time).toLocaleTimeString()}]</span>{' '}
            <span className={LEVEL_COLOR[l.level]}>[{l.level.toUpperCase()}]</span>{' '}
            <span className={LEVEL_COLOR[l.level]}>{l.message}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-2xs text-ink-3">
        {follow ? '日志文本可选中复制 · 新日志自动吸底' : '已暂停跟随——滚回底部恢复自动吸底'}
      </div>
    </div>
  )
}
