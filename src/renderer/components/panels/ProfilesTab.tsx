import { useCallback, useEffect, useState } from 'react'
import type { AppConfig, DshProfile, KernelInfo } from '../../../shared/types'

export function ProfilesTab(): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [profiles, setProfiles] = useState<DshProfile[]>([])
  const [kernels, setKernels] = useState<KernelInfo[]>([])
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

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

  const activate = async (id: string): Promise<void> => {
    setBusy(id)
    setMessage(null)
    const r = await window.dshDesktop.profiles.activate(id)
    setBusy(null)
    setMessage(r.ok ? { type: 'ok', text: '已切换档案（服务将自动重启换内核）' } : { type: 'err', text: r.error ?? '切换失败' })
    await refresh()
  }

  const remove = async (p: DshProfile): Promise<void> => {
    if (!window.confirm('删除档案「' + p.name + '」？仅删除档案配置，不影响 ~/.dsh 数据。')) return
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
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h2 className="text-lg font-semibold text-slate-100">配置档案（Profile）</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
          每个档案可绑定不同 DSH 内核版本——切换档案即切换内核（服务自动重启），
          适合不同项目用不同 DSH 版本做 A/B 验证。档案只保存配置，~/.dsh 数据始终共用。
        </p>

        <div className="mt-5 space-y-2">
          {profiles.map((p) => {
            const active = p.id === cfg?.activeProfileId
            return (
              <div
                key={p.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                  active ? 'border-amber-400/40 bg-amber-400/5' : 'border-slate-800/70 bg-slate-900/50'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-slate-100">{p.name}</span>
                    {active && (
                      <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-px text-[10px] text-amber-300">● 当前激活</span>
                    )}
                    {p.id === 'default' && (
                      <span className="rounded-full bg-slate-800 px-1.5 py-px text-[10px] text-slate-400">默认</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    绑定内核：<span className="font-mono text-slate-300">{p.kernelVersion ? 'v' + p.kernelVersion : '跟随全局默认'}</span>
                  </div>
                </div>

                <select
                  value={p.kernelVersion ?? ''}
                  onChange={(e) => void setKernel(p, e.target.value)}
                  disabled={busy === p.id + ':k'}
                  className="w-40 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-[12px] text-slate-100 outline-none focus:border-cyan-500 disabled:opacity-50"
                >
                  <option value="">（跟随默认）</option>
                  {kernels.map((k) => (
                    <option key={k.version} value={k.version}>v{k.version}</option>
                  ))}
                </select>

                {!active && (
                  <button
                    onClick={() => void activate(p.id)}
                    disabled={busy === p.id}
                    className="shrink-0 rounded-md bg-amber-400/20 px-2.5 py-1 text-[12px] text-amber-300 hover:bg-amber-400/30 disabled:opacity-50"
                  >
                    {busy === p.id ? '切换中…' : '激活'}
                  </button>
                )}
                {p.id !== 'default' && (
                  <button
                    onClick={() => void remove(p)}
                    disabled={busy === p.id}
                    className="shrink-0 rounded-md bg-slate-800 px-2.5 py-1 text-[12px] text-slate-400 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50"
                  >
                    删除
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
            placeholder="新档案名称，例如：实验项目A"
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[13px] text-slate-100 outline-none focus:border-amber-400"
          />
          <button
            onClick={() => void create()}
            disabled={busy === '__create__' || !newName.trim()}
            className="shrink-0 rounded-lg bg-amber-400 px-4 py-1.5 text-[13px] font-medium text-slate-950 hover:bg-amber-300 disabled:opacity-50"
          >
            {busy === '__create__' ? '创建中…' : '新建档案'}
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
    </div>
  )
}
