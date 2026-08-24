import { useCallback, useEffect, useState } from 'react'
import type { BackupInfo } from '../../../shared/types'

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`
}

export function BackupTab(): React.JSX.Element {
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    const list = await window.dshDesktop.backup.list()
    setBackups(list)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = async (): Promise<void> => {
    setCreating(true)
    setMessage(null)
    try {
      const info = await window.dshDesktop.backup.create(name || undefined)
      if (info) {
        setMessage({ type: 'ok', text: `已创建存档：${info.name}` })
        setName('')
      } else {
        setMessage({ type: 'err', text: '创建失败：未找到可备份的 ~/.dsh 数据' })
      }
      await refresh()
    } finally {
      setCreating(false)
    }
  }

  const restore = async (b: BackupInfo): Promise<void> => {
    if (!window.confirm(`确定恢复到「${b.name}」？\n\n将把该快照内容合并回 ~/.dsh（同名文件被覆盖）。\n恢复前会自动创建一个保护快照。`)) return
    setBusyId(b.id)
    setMessage(null)
    try {
      const r = await window.dshDesktop.backup.restore(b.id)
      setMessage(r.ok ? { type: 'ok', text: '恢复完成。建议重启 DSH 服务以生效。' } : { type: 'err', text: r.error ?? '恢复失败' })
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (b: BackupInfo): Promise<void> => {
    if (!window.confirm(`删除快照「${b.name}」？此操作不可恢复。`)) return
    const r = await window.dshDesktop.backup.delete(b.id)
    if (r.ok) await refresh()
    else setMessage({ type: 'err', text: r.error ?? '删除失败' })
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h2 className="text-lg font-semibold text-slate-100">备份与回滚</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
          对 <code className="rounded bg-slate-800 px-1 py-px font-mono text-[11px] text-amber-300">~/.dsh</code>{' '}
          中的配置、会话、凭据、插件、技能等创建快照（自动排除 node_modules）。定时自动备份默认开启（设置中可改周期/关闭）；插件安装/卸载与恢复操作前也会自动生成保护快照。
        </p>

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
            placeholder="存档名称（可选，默认 manual）"
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[13px] text-slate-100 outline-none focus:border-amber-400"
          />
          <button
            onClick={() => void create()}
            disabled={creating}
            className="shrink-0 rounded-lg bg-amber-400 px-4 py-1.5 text-[13px] font-medium text-slate-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
          >
            {creating ? '创建中…' : '创建存档'}
          </button>
        </div>

        {message && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-[12px] ${
              message.type === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {message.text}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">快照列表</h3>
        {backups.length === 0 && <div className="mt-3 text-[13px] text-slate-500">暂无快照</div>}
        <div className="mt-3 space-y-2">
          {backups.map((b) => (
            <div
              key={b.id}
              className="flex items-center gap-3 rounded-lg border border-slate-800/70 bg-slate-900/50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-slate-200">{b.name}</span>
                  <span
                    className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] ${
                      b.kind === 'manual'
                        ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
                        : 'border-slate-600/50 bg-slate-700/20 text-slate-400'
                    }`}
                  >
                    {b.kind === 'manual' ? '手动' : '自动'}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-slate-500">
                  {fmtTime(b.createdAt)} · {fmtSize(b.size)} · {b.entryCount} 个文件
                  {b.trigger ? ` · 触发：${b.trigger}` : ''}
                </div>
              </div>
              <button
                onClick={() => void restore(b)}
                disabled={busyId === b.id}
                className="shrink-0 rounded-md bg-amber-400/20 px-2.5 py-1 text-[12px] text-amber-300 hover:bg-amber-400/30 disabled:opacity-50"
              >
                {busyId === b.id ? '恢复中…' : '恢复'}
              </button>
              <button
                onClick={() => void remove(b)}
                className="shrink-0 rounded-md bg-slate-800 px-2.5 py-1 text-[12px] text-slate-400 hover:bg-red-500/20 hover:text-red-300"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}