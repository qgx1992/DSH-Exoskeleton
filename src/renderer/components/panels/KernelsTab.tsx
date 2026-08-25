import { useCallback, useEffect, useState } from 'react'
import type {
  AppConfig,
  KernelInfo,
  KernelProgress,
  KernelQuota,
  KernelRemoteVersion,
  KernelUpdateInfo,
  RuntimeInfo
} from '../../../shared/types'

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
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

  // 阶段 B：内置 Node 运行时
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [rtProgress, setRtProgress] = useState<KernelProgress | null>(null)
  // 阶段 B：内核更新检测
  const [update, setUpdate] = useState<KernelUpdateInfo | null>(null)
  // 阶段 C：磁盘配额
  const [quota, setQuota] = useState<KernelQuota | null>(null)
  const [quotaInput, setQuotaInput] = useState('')

  const refresh = useCallback(async () => {
    setInstalled(await window.dshDesktop.kernels.installed())
    setCfg(await window.dshDesktop.config.get())
    setRuntime(await window.dshDesktop.runtime.status())
    setQuota(await window.dshDesktop.kernels.quota())
  }, [])

  const loadVersions = useCallback(async () => {
    const list = await window.dshDesktop.kernels.available()
    setAvailable(list)
    if (!selected) setSelected(list[0]?.version ?? '')
  }, [selected])

  useEffect(() => {
    void refresh()
    void loadVersions()
    void window.dshDesktop.kernels.checkUpdate().then(setUpdate)
    const off = window.dshDesktop.kernels.onProgress((p) => {
      setProgress(p)
      if (p.stage === 'done') {
        setInstalling(null)
        setProgress(null)
        void refresh()
        void loadVersions()
        void window.dshDesktop.kernels.checkUpdate().then(setUpdate)
      } else if (p.stage === 'error') {
        setInstalling(null)
        setMessage({ type: 'err', text: p.message })
      }
    })
    const offRt = window.dshDesktop.runtime.onProgress((p) => {
      setRtProgress(p)
      if (p.stage === 'done' || p.stage === 'error') {
        setTimeout(() => {
          setRtProgress(null)
          void refresh()
        }, 800)
      }
    })
    return () => {
      off()
      offRt()
    }
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
      setMessage({ type: 'err', text: '「' + k.version + '」是当前默认内核，请先切换默认后再卸载' })
      return
    }
    if (!window.confirm('卸载内核 v' + k.version + '？相关目录将被删除（不会影响 ~/.dsh 数据）。')) return
    setBusyVersion(k.version)
    const r = await window.dshDesktop.kernels.uninstall(k.version)
    setBusyVersion(null)
    setMessage(r.ok ? { type: 'ok', text: '已卸载 v' + k.version } : { type: 'err', text: r.error ?? '卸载失败' })
    await refresh()
  }

  const setMode = async (mode: 'managed' | 'system'): Promise<void> => {
    const r = await window.dshDesktop.kernels.setMode(mode)
    setMessage(r.ok ? { type: 'ok', text: '内核模式已切换为「' + (mode === 'managed' ? '托管内核优先' : '始终使用系统 dsh') + '」' } : { type: 'err', text: r.error ?? '切换失败' })
    await refresh()
  }

  /** 一键升级：安装 latest → 设为默认（阶段 B） */
  const upgrade = async (): Promise<void> => {
    const latest = update?.latest
    if (!latest) return
    setInstalling(latest)
    setMessage(null)
    const r = await window.dshDesktop.kernels.install(latest)
    if (!r.ok) {
      setInstalling(null)
      setMessage({ type: 'err', text: r.error ?? '升级失败' })
      return
    }
    // 等待安装落盘后设为默认
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 500))
      const inst = await window.dshDesktop.kernels.installed()
      if (inst.some((k) => k.version === latest && k.status === 'installed')) break
    }
    const dr = await window.dshDesktop.kernels.setDefault(latest)
    setInstalling(null)
    setMessage(dr.ok ? { type: 'ok', text: '已升级并切换至 v' + latest } : { type: 'err', text: dr.error ?? '切换失败' })
    await refresh()
    void window.dshDesktop.kernels.checkUpdate().then(setUpdate)
  }

  /** 下载内置 Node 运行时（阶段 B） */
  const downloadRuntime = async (): Promise<void> => {
    setMessage(null)
    const r = await window.dshDesktop.runtime.download()
    if (!r.ok && r.error) setMessage({ type: 'err', text: r.error })
    // 成功由 runtime:progress(done) 收尾刷新
  }

  const removeRuntime = async (): Promise<void> => {
    if (!window.confirm('删除内置 Node 运行时？托管内核将回退使用系统 Node。')) return
    const r = await window.dshDesktop.runtime.remove()
    setMessage(r.ok ? { type: 'ok', text: '内置运行时已删除' } : { type: 'err', text: r.error ?? '删除失败' })
    await refresh()
  }

  /** 保存配额（阶段 C） */
  const saveQuota = async (): Promise<void> => {
    const n = parseInt(quotaInput, 10)
    if (Number.isNaN(n) || n < 0) {
      setQuotaInput(String(cfg?.kernelsQuotaMB ?? 1024))
      return
    }
    await window.dshDesktop.config.set({ kernelsQuotaMB: n })
    await refresh()
  }

  const activeVersion = cfg?.kernelMode === 'managed' ? cfg.defaultKernelVersion : null
  const rtBusy = runtime?.busy !== undefined && runtime.busy !== 'idle'

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

      {/* 阶段 B：内置 Node 运行时 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">Node 运行时（内置）</h3>
            <p className="mt-1 text-[12px] text-slate-500">
              托管内核的原生模块（node-pty/sharp）需按 Node ABI 编译，不能使用 Electron 内置 Node。
              下载后全新机器无需安装 Node.js 即可运行（真零门槛）。
            </p>
          </div>
          {runtime && (
            <div className="flex shrink-0 items-center gap-2">
              {runtime.installed ? (
                <button
                  onClick={() => void removeRuntime()}
                  disabled={rtBusy}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-[12px] text-slate-400 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50"
                >
                  {rtBusy ? '操作中…' : '删除'}
                </button>
              ) : (
                <button
                  onClick={() => void downloadRuntime()}
                  disabled={rtBusy}
                  className="rounded-lg bg-amber-400 px-3 py-1.5 text-[12px] font-medium text-slate-950 hover:bg-amber-300 disabled:opacity-50"
                >
                  {rtBusy ? '下载中…' : '下载内置 Node 运行时'}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="mt-3 space-y-1 text-[12px] text-slate-400">
          <div className="flex justify-between border-b border-slate-800/60 py-1">
            <span>内置 Node</span>
            <span className="font-mono text-slate-200">
              {runtime?.installed ? (runtime.version ?? '已安装') : '未安装'}
            </span>
          </div>
          <div className="flex justify-between border-b border-slate-800/60 py-1">
            <span>系统 Node（探测）</span>
            <span className="font-mono text-slate-300">{runtime?.systemNode ? runtime.systemNode : '未找到'}</span>
          </div>
        </div>
        {rtProgress && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[12px] text-slate-400">
              <span>{rtProgress.message}</span>
              <span className="font-mono">{rtProgress.percent.toFixed(0)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-300 to-emerald-500 transition-all"
                style={{ width: Math.min(100, rtProgress.percent) + '%' }}
              />
            </div>
          </div>
        )}
      </section>

      {/* 阶段 B：内核更新横幅 */}
      {update?.available && update.latest && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[13px] text-amber-200">
              <span className="font-semibold">内核新版本可用：v{update.latest}</span>
              <span className="ml-2 text-[12px] text-amber-300/80">当前 v{update.current ?? '系统 dsh'}</span>
              {update.rc && update.rc !== update.latest && (
                <span className="ml-2 rounded bg-slate-800/60 px-1.5 py-px font-mono text-[10px] text-slate-400">rc: v{update.rc}</span>
              )}
            </div>
            <button
              onClick={() => void upgrade()}
              disabled={installing !== null}
              className="shrink-0 rounded-lg bg-amber-400 px-4 py-1.5 text-[13px] font-medium text-slate-950 hover:bg-amber-300 disabled:opacity-50"
            >
              {installing !== null ? '升级中…' : '一键升级'}
            </button>
          </div>
        </section>
      )}

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

      {/* 阶段 C：存储配额 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">存储配额</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 text-[12px] text-slate-400 md:grid-cols-4">
          <div className="rounded-lg bg-slate-900/50 px-3 py-2">
            <div className="text-[11px] text-slate-500">内核占用</div>
            <div className="mt-0.5 font-mono text-slate-200">{(quota?.usedMB ?? 0).toFixed(1)} MB</div>
          </div>
          <div className="rounded-lg bg-slate-900/50 px-3 py-2">
            <div className="text-[11px] text-slate-500">Node 运行时</div>
            <div className="mt-0.5 font-mono text-slate-200">{(quota?.runtimeMB ?? 0).toFixed(1)} MB</div>
          </div>
          <div className="rounded-lg bg-slate-900/50 px-3 py-2">
            <div className="text-[11px] text-slate-500">磁盘剩余</div>
            <div className="mt-0.5 font-mono text-slate-200">{(quota?.diskFreeMB ?? 0).toFixed(0)} MB</div>
          </div>
          <div className="rounded-lg bg-slate-900/50 px-3 py-2">
            <div className="text-[11px] text-slate-500">配额上限</div>
            <div className="mt-0.5 flex items-center gap-1">
              <input
                type="number"
                min={0}
                value={quotaInput || String(cfg?.kernelsQuotaMB ?? 1024)}
                onChange={(e) => setQuotaInput(e.target.value)}
                onBlur={() => void saveQuota()}
                className="w-20 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-slate-200 outline-none focus:border-cyan-500"
              />
              <span>MB（0 = 不限）</span>
            </div>
          </div>
        </div>
        {quota && quota.quotaMB > 0 && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full rounded-full transition-all ${
                (quota.usedMB / quota.quotaMB) > 0.9 ? 'bg-red-400' : 'bg-cyan-400'
              }`}
              style={{ width: Math.min(100, (quota.usedMB / quota.quotaMB) * 100) + '%' }}
            />
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
                style={{ width: Math.min(100, progress.percent) + '%' }}
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
