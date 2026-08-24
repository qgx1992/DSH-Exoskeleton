import { useCallback, useEffect, useState } from 'react'
import type { InstalledPlugin, PluginCatalogItem } from '../../../shared/types'

export function PluginsTab(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<PluginCatalogItem[]>([])
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const refreshInstalled = useCallback(async () => {
    const list = await window.dshDesktop.plugins.installed()
    setInstalled(list)
  }, [])

  const loadCatalog = useCallback(async (q: string): Promise<void> => {
    setLoadingCatalog(true)
    try {
      setCatalog(await window.dshDesktop.plugins.catalog(q))
    } finally {
      setLoadingCatalog(false)
    }
  }, [])

  useEffect(() => {
    void refreshInstalled()
    void loadCatalog('')
  }, [loadCatalog, refreshInstalled])

  const isInstalled = (pkg: string): boolean => installed.some((i) => i.name === pkg)

  const install = async (pkg: string): Promise<void> => {
    setBusyName(pkg)
    setMessage(null)
    try {
      const r = await window.dshDesktop.plugins.install(pkg)
      setMessage(
        r.ok
          ? { type: 'ok', text: `已安装 ${pkg}（安装前已自动备份）` }
          : { type: 'err', text: r.error ?? `安装 ${pkg} 失败` }
      )
      await refreshInstalled()
    } finally {
      setBusyName(null)
    }
  }

  const uninstall = async (name: string): Promise<void> => {
    if (!window.confirm(`卸载插件「${name}」？卸载前会自动创建备份快照。`)) return
    setBusyName(name)
    setMessage(null)
    try {
      const r = await window.dshDesktop.plugins.uninstall(name)
      setMessage(
        r.ok
          ? { type: 'ok', text: `已卸载 ${name}（卸载前已自动备份）` }
          : { type: 'err', text: r.error ?? `卸载 ${name} 失败` }
      )
      await refreshInstalled()
    } finally {
      setBusyName(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 已安装 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">
          已安装（{installed.length}）
        </h3>
        {installed.length === 0 ? (
          <div className="mt-3 text-[13px] text-slate-500">当前 Web Profile 暂无独立插件依赖</div>
        ) : (
          <div className="mt-3 space-y-2">
            {installed.map((p) => (
              <div key={p.name} className="flex items-center gap-3 rounded-lg border border-slate-800/70 bg-slate-900/50 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-slate-200">{p.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-slate-500">{p.version}</span>
                <button
                  onClick={() => void uninstall(p.name)}
                  disabled={busyName === p.name}
                  className="shrink-0 rounded-md bg-slate-800 px-2.5 py-1 text-[12px] text-slate-400 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50"
                >
                  {busyName === p.name ? '处理中…' : '卸载'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 社区目录 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">社区插件</h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadCatalog(query)
              }}
              placeholder="搜索 dsh-plugin…"
              className="w-56 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[13px] text-slate-100 outline-none focus:border-amber-400"
            />
            <button
              onClick={() => void loadCatalog(query)}
              disabled={loadingCatalog}
              className="rounded-lg bg-slate-800 px-3 py-1.5 text-[12px] text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            >
              {loadingCatalog ? '搜索中…' : '搜索'}
            </button>
          </div>
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

        <div className="mt-3 space-y-2">
          {catalog.length === 0 && !loadingCatalog && (
            <div className="text-[13px] text-slate-500">
              未获取到插件列表（GitHub topic dsh-plugin / npm keywords 为空或网络受限）。
            </div>
          )}
          {catalog.map((p) => (
            <div
              key={`${p.source}-${p.packageName}`}
              className="flex items-start gap-3 rounded-lg border border-slate-800/70 bg-slate-900/50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[13px] font-medium text-amber-200/90">{p.packageName}</span>
                  <span
                    className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] ${
                      p.source === 'github'
                        ? 'border-slate-600/60 bg-slate-700/20 text-slate-400'
                        : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    }`}
                  >
                    {p.source === 'github' ? 'GitHub' : 'npm'}
                  </span>
                  {p.version && (
                    <span className="shrink-0 font-mono text-[10px] text-slate-500">v{p.version}</span>
                  )}
                  {p.stars > 0 && <span className="shrink-0 text-[10px] text-amber-300/80">★ {p.stars}</span>}
                </div>
                <p className="mt-0.5 line-clamp-2 text-[12px] text-slate-400">{p.description || '暂无描述'}</p>
              </div>
              <button
                onClick={() => {
                  if (p.url) void window.dshDesktop.app.openExternal(p.url)
                }}
                className="shrink-0 rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-700"
                title={p.url}
              >
                主页
              </button>
              <button
                onClick={() => void install(p.packageName)}
                disabled={isInstalled(p.packageName) || busyName === p.packageName}
                className="shrink-0 rounded-md bg-amber-400/90 px-2.5 py-1 text-[12px] font-medium text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              >
                {busyName === p.packageName ? '安装中…' : isInstalled(p.packageName) ? '已安装' : '安装'}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}