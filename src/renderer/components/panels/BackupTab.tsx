import { useCallback, useEffect, useState } from 'react'
import type { BackupInfo } from '../../../shared/types'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Card, Notice } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { IconShield } from '../ui/icons'

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
  /** 正在任选恢复的快照（该行展开勾选面板） */
  const [picking, setPicking] = useState<BackupInfo | null>(null)
  /** 任选恢复勾选条目 */
  const [selected, setSelected] = useState<string[]>([])

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

  /** 任选恢复：打开勾选面板，默认全选（= 恢复全部） */
  const openPicker = (b: BackupInfo): void => {
    setSelected([...b.entries])
    setPicking(b)
  }

  const toggleEntry = (e: string): void => {
    setSelected((s) => (s.includes(e) ? s.filter((x) => x !== e) : [...s, e]))
  }

  const toggleAll = (b: BackupInfo): void => {
    setSelected((s) => (s.length === b.entries.length ? [] : [...b.entries]))
  }

  /** 执行恢复：entries 为空数组不合法；传全部条目等价于「恢复全部」，只传部分则任选恢复 */
  const doRestore = async (b: BackupInfo, entries: string[]): Promise<void> => {
    if (entries.length === 0) return
    const label = entries.length === b.entries.length ? '全部项目' : '所选 ' + entries.length + ' 项'
    if (
      !window.confirm(`确定恢复到「${b.name}」？\n\n将把${label}合并回 ~/.dsh（同名文件被覆盖）。\n恢复前会自动创建一个保护快照。`)
    )
      return
    setBusyId(b.id)
    setMessage(null)
    try {
      const r = await window.dshDesktop.backup.restore(b.id, entries)
      setMessage(r.ok ? { type: 'ok', text: '恢复完成。建议重启 DSH 服务以生效。' } : { type: 'err', text: r.error ?? '恢复失败' })
      // R-27: 恢复会额外生成保护快照，刷新列表展示
      if (r.ok) setPicking(null)
      await refresh()
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
      <Card>
        <h2 className="text-lg font-semibold text-ink">备份与回滚</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">
          对 <code className="rounded bg-surface-2 px-1 py-px font-mono text-2xs text-accent">~/.dsh</code>{' '}
          中的配置、会话、凭据、插件、技能等创建快照（自动排除 node_modules）。插件安装/卸载与恢复操作前会自动生成保护快照；也可手动创建存档。
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
            className="min-w-0 flex-1 rounded-control border border-rule bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-3 hover:border-rule-strong focus:border-accent/60 focus:ring-[3px] focus:ring-accent/15"
          />
          <Button variant="primary" loading={creating} disabled={creating} onClick={() => void create()}>
            {creating ? '创建中…' : '创建存档'}
          </Button>
        </div>

        {message && (
          <div className="mt-3">
            <Notice tone={message.type}>{message.text}</Notice>
          </div>
        )}
      </Card>

      <Card>
        <h3 className="text-xs font-semibold tracking-wider text-ink-2">快照列表</h3>
        {backups.length === 0 && (
          <EmptyState
            className="px-0 py-6"
            icon={<IconShield size={30} />}
            title="暂无快照"
            hint="手动创建存档，或进行插件安装等会自动生成保护快照的操作"
          />
        )}
        <div className="mt-3 space-y-1.5">
          {backups.map((b) => (
            <div key={b.id}>
              <div className="flex items-center gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{b.name}</span>
                    <Badge tone={b.kind === 'manual' ? 'amber' : 'gray'}>{b.kind === 'manual' ? '手动' : '自动'}</Badge>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-2xs text-ink-3">
                    {fmtTime(b.createdAt)} · {fmtSize(b.size)} · {b.entryCount} 个文件
                    {b.trigger ? ` · 触发：${b.trigger}` : ''}
                  </div>
                </div>
                <Button
                  variant="accent"
                  size="sm"
                  loading={busyId === b.id}
                  disabled={busyId === b.id}
                  onClick={() => void doRestore(b, b.entries)}
                >
                  {busyId === b.id ? '恢复中…' : '恢复'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busyId === b.id}
                  onClick={() => openPicker(b)}
                  title="选择要恢复的项目（如只恢复插件）"
                >
                  任选恢复
                </Button>
                <Button variant="danger" size="sm" onClick={() => void remove(b)}>
                  删除
                </Button>
              </div>

              {picking?.id === b.id && (
                <div className="mt-2 rounded-control border border-accent/30 bg-surface p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-ink-2">
                      勾选要恢复的项目（默认全选 = 恢复全部，如只勾选插件可单独恢复插件）
                    </div>
                    <button
                      onClick={() => toggleAll(b)}
                      className="shrink-0 text-2xs text-accent underline-offset-2 hover:underline"
                    >
                      全选 / 全不选
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {b.entries.map((e) => (
                      <label
                        key={e}
                        className="flex cursor-pointer items-center gap-1.5 rounded-control border border-rule bg-canvas/60 px-2 py-1 text-xs text-ink-2 transition-colors hover:border-accent/40"
                      >
                        <input
                          type="checkbox"
                          checked={selected.includes(e)}
                          onChange={() => toggleEntry(e)}
                          className="accent-accent"
                        />
                        {e}
                      </label>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busyId === b.id}
                      disabled={selected.length === 0 || busyId === b.id}
                      onClick={() => void doRestore(b, selected)}
                    >
                      {busyId === b.id ? '恢复中…' : '恢复所选（' + selected.length + '）'}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setPicking(null)}>
                      取消
                    </Button>
                    <span className="text-2xs text-ink-3">恢复前会自动创建保护快照</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}