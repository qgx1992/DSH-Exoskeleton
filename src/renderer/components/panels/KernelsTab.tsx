import { useCallback, useEffect, useState } from 'react'
import type { AppConfig, KernelInfo, KernelProgress, KernelRemoteVersion } from '../../../shared/types'

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function KernelsTab(): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [installed, setInstalled] = useState<KernelInfo[]>([])
  const [available, setAvailable] = useState<KernelRemoteVersion[]>([])
  const [selected, setSelected] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)
  const [progress, setProgress] = useState<KernelProgress | null>(null)
  const [busyVersion, setBusyVersion] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    setInstalled(await window.dshDesktop.kernels.installed())
    setCfg(await window.dshDesktop.config.get())
  }, [])

  const loadVersions = useCallback(async () => {
    const list = await window.dshDesktop.kernels.available()
    setAvailable(list)
    if (!selected) setSelected(list[0]?.version ?? '')
  }, [selected])

  useEffect(() => {
    void refresh()
    void loadVersions()
    const off = window.dshDesktop.kernels.onProgress((p) => {
      setProgress(p)
      if (p.stage === 'done') {
        setInstalling(null)
        setProgress(null)
        void refresh()
        void loadVersions()
      } else if (p.stage === 'error') {
        setInstalling(null)
        setMessage({ type: 'err', text: p.message })
      }
    })
    return off
  }, [loadVersions, refresh])

  const install = async (): Promise<void> => {
    if (!selected) return
    setInstalling(selected)
    setMessage(null)
    const r = await window.dshDesktop.kernels.install(selected)
    if (!r.ok) {
      setInstalling(null)
      setMessage({ type: 'err', text: r.error ?? '安装失败' })
    }
    // 成功时由 progress(done) 事件收尾
  }

  const setDefault = async (v: string | null): Promise<void> => {
    setBusyVersion(v ?? '(none)')
    const r = await window.dshDesktop.kernels.setDefault(v)
    setBusyVersion(null)
    if (!r.ok) setMessage({ type: 'err', text: r.error ?? '设置失败' })
    await refresh()
  }

  const uninstall = async (k: KernelInfo): Promise<void> => {
    if (cfg?.defaultKernelVersion === k.version) {
      setMessage({ type: 'err', text: `「${k.version}」是当前默认内核，请先切换默认后再卸载` })
      return
    }
    if (!window.confirm(`卸载内核 v${k.version}？相关目录将被删除（不会影响 ~/.dsh 数据）。`)) return
    setBusyVersion(k.version)
    const r = await window.dshDesktop.kernels.uninstall(k.version)
    setBusyVersion(null)
    setMessage(r.ok ? { type: 'ok', text: `已卸载 v${k.version}` } : { type: 'err', text: r.error ?? '卸载失败' })
    await refresh()
  }

  const setMode = async (mode: 'managed' | 'system'): Promise<void> => {
    const r = await window.dshDesktop.kernels.setMode(mode)
    setMessage(r.ok ? { type: 'ok', text: `内核模式已切换为「${mode === 'managed' ? '托管内核优先' : '始终使用系统 dsh'}」` } : { type: 'err', text: r.error ?? '切换失败' })
    await refresh()
  }

  const activeVersion = cfg?.kernelMode === 'managed' ? cfg.defaultKernelVersion : null

  return (
    <div className="flex flex-col gap-6">
      {/* 模式与说明 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">DSH 内核（多版本共存）</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
              托管内核存放于 <code className="rounded bg-slate-800 px-1 py-px font-mono text-[11px] text-amber-300">kernels/</code>，各版本隔离、
              可并存切换。启动时默认使用「托管内核」；未安装任何托管内核时自动回退系统 dsh。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-slate-400">模式</span>
            <button
              onClick={() => void setMode(cfg?.kernelMode === 'managed' ? 'system' : 'managed')}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
                cfg?.kernelMode === 'managed'
                  ? 'bg-amber-400/90 text-slate-950 hover:bg-amber-300'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {cfg?.kernelMode === 'managed' ? '托管内核优先' : '始终用系统 dsh'}
            </button>
          </div>
        </div>
      </section>

      {/* 已安装版本 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">已安装（{installed.length}）</h3>
        {installed.length === 0 ? (
          <div className="mt-3 text-[13px] text-slate-500">
            尚未安装托管内核。{cfg?.kernelMode === 'managed' ? '当前使用系统 dsh。' : '模式为「始终用系统 dsh」。'}
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {installed.map((k) => (
              <div key={k.version} className="flex items-center gap-3 rounded-lg border border-slate-800/70 bg-slate-900/50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13px] font-medium text-slate-100">v{k.version}</span>
                    {activeVersion === k.version && (
                      <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-px text-[10px] text-amber-300">● 当前默认</span>
                    )}
                    {k.status === 'error' && (
                      <span className="rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-px text-[10px] text-red-300">安装异常</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {fmtSize(k.size)} · {k.installedAt ? new Date(k.installedAt).toLocaleString() : '-'}
                  </div>
                </div>
                {activeVersion !== k.version && k.status !== 'error' && (
                  <button
                    onClick={() => void setDefault(k.version)}
                    disabled={busyVersion === k.version}
                    className="shrink-0 rounded-md bg-amber-400/20 px-2.5 py-1 text-[12px] text-amber-300 hover:bg-amber-400/30 disabled:opacity-50"
                  >
                    {busyVersion === k.version ? '切换中…' : '设为默认'}
                  </button>
                )}
                <button
                  onClick={() => void uninstall(k)}
                  disabled={busyVersion === k.version || activeVersion === k.version}
                  className="shrink-0 rounded-md bg-slate-800 px-2.5 py-1 text-[12px] text-slate-400 hover:bg-red-500/20 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  卸载
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 安装新版本 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">安装新版本</h3>
        <div className="mt-3 flex gap-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={installing !== null || available.length === 0}
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-[13px] text-slate-100 outline-none focus:border-amber-400 disabled:opacity-50"
          >
            {available.length === 0 && <option value="">（无法获取版本列表，检查网络）</option>}
            {available.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}{installed.some((i) => i.version === v.version) ? '（已安装）' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={() => void install()}
            disabled={!selected || installing !== null || available.length === 0}
            className="shrink-0 rounded-lg bg-amber-400 px-4 py-1.5 text-[13px] font-medium text-slate-950 hover:bg-amber-300 disabled:opacity-50"
          >
            {installing !== null ? '安装中…' : '安装'}
          </button>
        </div>

        {progress && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-[12px] text-slate-400">
              <span>安装 v{progress.version}</span>
              <span className="font-mono">{progress.percent.toFixed(0)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-300 to-amber-500 transition-all"
                style={{ width: `${Math.min(100, progress.percent)}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-slate-500">{progress.message}</div>
          </div>
        )}

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