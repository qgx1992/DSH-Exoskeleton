import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SessionInfo } from '../../../shared/types'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Card, Notice } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { IconSearch } from '../ui/icons'

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
    <div className="mx-auto max-w-4xl space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">会话</h2>
            <p className="mt-1 text-xs text-ink-3">
              本地会话数据（~/.dsh/sessions）· {sessions.length} 个 · 点击「打开」在 DSH Web UI 中查看
            </p>
          </div>
          <div className="flex gap-2">
            <div className="relative">
              <IconSearch size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题 / 项目 / 内容…"
                className="w-64 rounded-control border border-rule bg-surface-2 py-1.5 pl-7 pr-2.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-3 hover:border-rule-strong focus:border-accent/60"
              />
            </div>
            <Button variant="secondary" loading={loading} disabled={loading} onClick={() => void refresh()}>
              {loading ? '刷新中…' : '刷新'}
            </Button>
          </div>
        </div>

        {message && (
          <div className="mt-4">
            <Notice tone={message.type}>{message.text}</Notice>
          </div>
        )}

        <div className="mt-4 space-y-1.5">
          {!loading && filtered.length === 0 && (
            <EmptyState
              title={sessions.length === 0 ? '暂无会话' : '没有匹配的会话'}
              hint={
                sessions.length === 0
                  ? '会话数据保存在 ~/.dsh/sessions，启动服务并对话后出现在这里'
                  : '换个关键词试试'
              }
              action={sessions.length === 0 ? { label: '刷新列表', onClick: () => void refresh() } : undefined}
            />
          )}
          {filtered.map((s) => (
            <div
              key={s.uuid}
              className="flex items-center gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink" title={s.title}>
                    {s.title}
                  </span>
                  {s.project && <Badge tone="gray">{s.project}</Badge>}
                </div>
                <div className="mt-0.5 truncate text-xs text-ink-3" title={s.firstUserText}>
                  {s.firstUserText || s.uuid}
                </div>
                <div className="mt-0.5 font-mono text-2xs text-ink-3">
                  {fmtTime(s.modifiedAt)} · {fmtSize(s.size)} · {s.uuid.slice(0, 8)}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <Button
                  variant="accent"
                  size="sm"
                  loading={busyUuid === s.uuid}
                  disabled={busyUuid === s.uuid}
                  onClick={() => void open(s)}
                >
                  {busyUuid === s.uuid ? '处理中…' : '打开'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyUuid === s.uuid}
                  onClick={() => void show(s)}
                  title="在资源管理器中显示"
                >
                  定位
                </Button>
                <Button variant="ghost" size="sm" disabled={busyUuid === s.uuid} onClick={() => void doExport(s)}>
                  导出
                </Button>
                <Button variant="danger" size="sm" disabled={busyUuid === s.uuid} onClick={() => void remove(s)}>
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
