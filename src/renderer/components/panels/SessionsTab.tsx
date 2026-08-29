import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SessionInfo } from '../../../shared/types'

interface Props {
  /** 关闭管理面板，回到 DSH Web UI（打开会话后自动切回） */
  onOpenWebUI: () => void
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`
}

export function SessionsTab({ onOpenWebUI }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [busyUuid, setBusyUuid] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setSessions(await window.dshDesktop.sessions.list())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) =>
      [s.title, s.project, s.firstUserText, s.workspace, s.uuid].some((v) => (v || '').toLowerCase().includes(q))
    )
  }, [sessions, query])

  const open = async (s: SessionInfo): Promise<void> => {
    setBusyUuid(s.uuid)
    setMessage(null)
    try {
      const r = await window.dshDesktop.sessions.open(s.uuid)
      setMessage(r.ok ? { type: 'ok', text: '已在 Web UI 中打开会话' } : { type: 'err', text: r.error ?? '打开失败' })
      if (r.ok) onOpenWebUI()
    } finally {
      setBusyUuid(null)
    }
  }

  const show = async (s: SessionInfo): Promise<void> => {
    setBusyUuid(s.uuid)
    setMessage(null)
    try {
      const r = await window.dshDesktop.sessions.show(s.uuid)
      if (!r.ok) setMessage({ type: 'err', text: r.error ?? '定位失败' })
    } finally {
      setBusyUuid(null)
    }
  }

  const doExport = async (s: SessionInfo): Promise<void> => {
    setBusyUuid(s.uuid)
    setMessage(null)
    try {
      const r = await window.dshDesktop.sessions.export(s.uuid)
      if (r.ok) setMessage({ type: 'ok', text: r.path ? `已导出：${r.path}` : '已导出' })
      else if (r.error && r.error !== '已取消') setMessage({ type: 'err', text: r.error })
    } finally {
      setBusyUuid(null)
    }
  }

  const remove = async (s: SessionInfo): Promise<void> => {
    if (!window.confirm(`删除会话「${s.title}」？\n\n将删除目录 ${s.sessionDir}，此操作不可恢复。`)) return
    setBusyUuid(s.uuid)
    setMessage(null)
    try {
      const r = await window.dshDesktop.sessions.remove(s.uuid)
      setMessage(r.ok ? { type: 'ok', text: '会话已删除' } : { type: 'err', text: r.error ?? '删除失败' })
      if (r.ok) await refresh()
    } finally {
      setBusyUuid(null)
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">会话</h2>
            <p className="mt-1 text-[12px] text-slate-500">
              本地会话数据（~/.dsh/sessions）· {sessions.length} 个 · 点击可在 DSH Web UI 中打开
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题 / 项目 / 内容…"
              className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[13px] text-slate-100 outline-none focus:border-cyan-500"
            />
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="shrink-0 rounded-lg bg-slate-800 px-3 py-1.5 text-[12px] text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            >
              {loading ? '刷新中…' : '刷新'}
            </button>
          </div>
        </div>

        {message && (
          <div
            className={`mt-4 rounded-lg border px-3 py-2 text-[12px] ${
              message.type === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="mt-4 space-y-2">
          {!loading && filtered.length === 0 && (
            <div className="text-[13px] text-slate-500">
              {sessions.length === 0 ? '暂无会话' : '没有匹配的会话'}
            </div>
          )}
          {filtered.map((s) => (
            <div key={s.uuid} className="flex items-center gap-3 rounded-lg border border-slate-800/70 bg-slate-900/50 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-slate-200" title={s.title}>{s.title}</span>
                  {s.project && (
                    <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-px text-[10px] text-slate-400">{s.project}</span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-slate-500" title={s.firstUserText}>
                  {s.firstUserText || s.uuid}
                </div>
                <div className="mt-0.5 text-[10px] text-slate-600">
                  {fmtTime(s.modifiedAt)} · {fmtSize(s.size)} · {s.uuid.slice(0, 8)}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <button
                  onClick={() => void open(s)}
                  disabled={busyUuid === s.uuid}
                  className="rounded-md bg-cyan-500/20 px-2.5 py-1 text-[12px] text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-50"
                >
                  {busyUuid === s.uuid ? '处理中…' : '打开'}
                </button>
                <button
                  onClick={() => void show(s)}
                  disabled={busyUuid === s.uuid}
                  className="rounded-md bg-slate-800 px-2.5 py-1 text-[12px] text-slate-400 hover:bg-slate-700 disabled:opacity-50"
                  title="在资源管理器中显示"
                >
                  定位
                </button>
                <button
                  onClick={() => void doExport(s)}
                  disabled={busyUuid === s.uuid}
                  className="rounded-md bg-slate-800 px-2.5 py-1 text-[12px] text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                >
                  导出
                </button>
                <button
                  onClick={() => void remove(s)}
                  disabled={busyUuid === s.uuid}
                  className="rounded-md bg-slate-800 px-2.5 py-1 text-[12px] text-slate-400 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
