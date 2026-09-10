import { useCallback, useEffect, useState } from 'react'
import type { AppConfig, DshProfile, KernelInfo } from '../../../shared/types'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Input, Select } from '../ui/Field'
import { Card, Notice } from '../ui/Card'
import { useConfirm } from '../ui/Confirm'

export function ProfilesTab(): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [profiles, setProfiles] = useState<DshProfile[]>([])
  const [kernels, setKernels] = useState<KernelInfo[]>([])
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const confirm = useConfirm()

  const refresh = useCallback(async () => {
    const [ps, ks, c] = await Promise.all([
      window.dshDesktop.profiles.list(),
      window.dshDesktop.kernels.installed(),
      window.dshDesktop.config.get()
    ])
    setProfiles(ps)
    setKernels(ks)
    setCfg(c)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    setBusy('__create__')
    setMessage(null)
    const r = await window.dshDesktop.profiles.create(name)
    setBusy(null)
    setMessage(r.ok ? { type: 'ok', text: '档案「' + name + '」已创建' } : { type: 'err', text: r.error ?? '创建失败' })
    if (r.ok) {
      setNewName('')
      await refresh()
    }
  }

  /** 激活档案会换内核并重启服务（Web UI 短暂中断）→ 与「设为默认内核」同一确认口径 */
  const activate = async (id: string): Promise<void> => {
    const p = profiles.find((x) => x.id === id)
    const ok = await confirm({
      title: `激活档案「${p?.name ?? id}」？`,
      body: '· 启用该档案绑定的内核（未绑定则跟随全局默认）\n· 若 DSH 服务正在运行会自动重启（Web UI 短暂中断，会话数据不丢失）',
      confirmText: '激活'
    })
    if (!ok) return
    setBusy(id)
    setMessage(null)
    const r = await window.dshDesktop.profiles.activate(id)
    setBusy(null)
    setMessage(r.ok ? { type: 'ok', text: '已切换档案（服务将自动重启换内核）' } : { type: 'err', text: r.error ?? '切换失败' })
    await refresh()
  }

  const remove = async (p: DshProfile): Promise<void> => {
    const ok = await confirm({
      title: `删除档案「${p.name}」？`,
      body: '仅删除档案配置，不影响 ~/.dsh 数据。',
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    setBusy(p.id)
    setMessage(null)
    const r = await window.dshDesktop.profiles.delete(p.id)
    setBusy(null)
    setMessage(r.ok ? { type: 'ok', text: '档案已删除' } : { type: 'err', text: r.error ?? '删除失败' })
    await refresh()
  }

  const setKernel = async (p: DshProfile, version: string): Promise<void> => {
    const v = version === '' ? null : version
    setBusy(p.id + ':k')
    setMessage(null)
    const r = await window.dshDesktop.profiles.setKernel(p.id, v)
    setBusy(null)
    setMessage(r.ok ? { type: 'ok', text: '「' + p.name + '」已绑定 v' + (v ?? '默认') + '（服务将自动重启换内核）' } : { type: 'err', text: r.error ?? '绑定失败' })
    await refresh()
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <h2 className="text-lg font-semibold text-ink">配置档案（Profile）</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">
          每个档案可绑定不同 DSH 内核版本——切换档案即切换内核（服务自动重启），
          适合不同项目用不同 DSH 版本做 A/B 验证。档案只保存配置，~/.dsh 数据始终共用。
        </p>

        <div className="mt-4 space-y-2">
          {profiles.map((p) => {
            const active = p.id === cfg?.activeProfileId
            return (
              <div
                key={p.id}
                className={`flex items-center gap-3 rounded-control border px-3 py-2.5 ${
                  active ? 'border-accent/40 bg-accent/5' : 'border-rule/60 bg-canvas/50'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{p.name}</span>
                    {active && <Badge tone="cyan">● 当前激活</Badge>}
                    {p.id === 'default' && <Badge tone="gray">默认</Badge>}
                  </div>
                  <div className="mt-0.5 text-2xs text-ink-3">
                    绑定内核：<span className="font-mono text-ink-2">{p.kernelVersion ? 'v' + p.kernelVersion : '跟随全局默认'}</span>
                  </div>
                </div>

                <Select
                  value={p.kernelVersion ?? ''}
                  onChange={(e) => void setKernel(p, e.target.value)}
                  disabled={busy === p.id + ':k'}
                  className="w-40 font-mono text-xs"
                >
                  <option value="">（跟随默认）</option>
                  {kernels.map((k) => (
                    <option key={k.version} value={k.version}>
                      v{k.version}
                    </option>
                  ))}
                </Select>

                {!active && (
                  <Button
                    variant="accent"
                    size="sm"
                    loading={busy === p.id}
                    disabled={busy === p.id}
                    onClick={() => void activate(p.id)}
                  >
                    {busy === p.id ? '切换中…' : '激活'}
                  </Button>
                )}
                {p.id !== 'default' && (
                  <Button variant="danger" size="sm" disabled={busy === p.id} onClick={() => void remove(p)}>
                    删除
                  </Button>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex gap-2">
          <div className="flex-1">
            <Input
              mono={false}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
              }}
              placeholder="新档案名称，例如：实验项目A"
            />
          </div>
          <Button
            variant="primary"
            loading={busy === '__create__'}
            disabled={busy === '__create__' || !newName.trim()}
            onClick={() => void create()}
          >
            {busy === '__create__' ? '创建中…' : '新建档案'}
          </Button>
        </div>

        {message && (
          <div className="mt-3">
            <Notice tone={message.type}>{message.text}</Notice>
          </div>
        )}
      </Card>
    </div>
  )
}
