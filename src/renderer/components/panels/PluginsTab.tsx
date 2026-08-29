import { useCallback, useEffect, useState } from 'react'
import type { InstalledPlugin, PluginCatalogItem } from '../../../shared/types'
import { RECOMMENDED_PLUGINS, type RecommendedPlugin } from '../../../shared/recommended-plugins'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Card, Notice } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { IconSearch } from '../ui/icons'

export function PluginsTab(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<PluginCatalogItem[]>([])
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [installingAll, setInstallingAll] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const refreshInstalled = useCallback(async () => {
    const list = await window.dshDesktop.plugins.installed()
    setInstalled(list)
  }, [])

  /** 联网重检全部已安装插件（静默：只刷新列表与徽标，不覆盖提示消息） */
  const refreshUpdates = useCallback(async (): Promise<void> => {
    setInstalled(await window.dshDesktop.plugins.checkUpdate())
  }, [])

  /** 顶部「检查更新」：联网检测并给出汇总提示 */
  const checkUpdates = useCallback(async (): Promise<void> => {
    setCheckingUpdates(true)
    setMessage(null)
    try {
      const list = await window.dshDesktop.plugins.checkUpdate()
      setInstalled(list)
      const n = list.filter((p) => p.update?.available).length
      setMessage(
        n > 0
          ? { type: 'ok', text: '检查完成：' + n + ' 个插件有新版本可升级' }
          : { type: 'ok', text: '检查完成：所有已安装插件均是最新版本' }
      )
    } catch (err) {
      setMessage({ type: 'err', text: err instanceof Error ? err.message : '检查更新失败' })
    } finally {
      setCheckingUpdates(false)
    }
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
  const isRecommendedInstalled = (p: RecommendedPlugin): boolean => installed.some((i) => i.name === p.name)

  const install = async (pkg: string): Promise<void> => {
    setBusyName(pkg)
    setMessage(null)
    try {
      const r = await window.dshDesktop.plugins.install(pkg)
      setMessage(
        r.ok
          ? { type: 'ok', text: '已安装 ' + pkg + '（安装前已自动备份）' }
          : { type: 'err', text: r.error ?? '安装 ' + pkg + ' 失败' }
      )
      await refreshInstalled()
    } finally {
      setBusyName(null)
    }
  }

  const installAllRecommended = async (): Promise<void> => {
    const todo = RECOMMENDED_PLUGINS.filter((p) => !isRecommendedInstalled(p))
    if (todo.length === 0) return
    setInstallingAll(true)
    setMessage(null)
    let okCount = 0
    let failCount = 0
    for (const p of todo) {
      try {
        const r = await window.dshDesktop.plugins.install(p.installTarget)
        if (r.ok) okCount++
        else failCount++
      } catch {
        failCount++
      }
    }
    setInstallingAll(false)
    setMessage(
      failCount === 0
        ? { type: 'ok', text: '已批量安装 ' + okCount + ' 个推荐插件（安装前已自动备份）' }
        : { type: 'err', text: '批量安装完成：成功 ' + okCount + ' 个，失败 ' + failCount + ' 个' }
    )
    await refreshInstalled()
  }

  const uninstall = async (name: string): Promise<void> => {
    if (!window.confirm('卸载插件「' + name + '」？卸载前会自动创建备份快照。')) return
    setBusyName(name)
    setMessage(null)
    try {
      const r = await window.dshDesktop.plugins.uninstall(name)
      setMessage(
        r.ok
          ? { type: 'ok', text: '已卸载 ' + name + '（卸载前已自动备份）' }
          : { type: 'err', text: r.error ?? '卸载 ' + name + ' 失败' }
      )
      await refreshInstalled()
    } finally {
      setBusyName(null)
    }
  }

  const upgrade = async (name: string, latest?: string): Promise<void> => {
    setBusyName(name)
    setMessage(null)
    try {
      const r = await window.dshDesktop.plugins.upgrade(name, latest)
      setMessage(
        r.ok
          ? { type: 'ok', text: '已升级插件 ' + name + (latest ? ' 到 v' + latest : '') + '（升级前已自动备份）' }
          : { type: 'err', text: r.error ?? '升级 ' + name + ' 失败' }
      )
      // 升级成功后静默重检，让「有新版本」徽标即时归零
      if (r.ok) await refreshUpdates()
    } finally {
      setBusyName(null)
    }
  }

  const pendingCount = RECOMMENDED_PLUGINS.filter((p) => !isRecommendedInstalled(p)).length

  return (
    <div className="flex flex-col gap-4">
      {message && <Notice tone={message.type}>{message.text}</Notice>}

      {/* 已安装 */}
      <Card>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wider text-ink-2">已安装（{installed.length}）</h3>
          <Button
            variant="secondary"
            size="sm"
            loading={checkingUpdates}
            disabled={checkingUpdates || installed.length === 0}
            onClick={() => void checkUpdates()}
          >
            {checkingUpdates ? '检查中…' : '检查更新'}
          </Button>
        </div>
        {installed.length === 0 ? (
          <div className="mt-3 text-sm text-ink-3">当前 Web Profile 暂无独立插件依赖</div>
        ) : (
          <div className="mt-3 space-y-1.5">
            {installed.map((p) => {
              const upd = p.update
              const upgradable = !!upd?.available && !!upd.latest
              return (
                <div key={p.name} className="flex items-center gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink" title={upd?.current && upd.current !== upd.declared ? '当前实际 v' + upd.current : p.name}>
                    {p.name}
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-ink-3" title={upd?.current ? '当前实际 v' + upd.current : undefined}>
                    {p.version}
                  </span>
                  {upgradable && <Badge tone="amber">有新版本 v{upd!.latest}</Badge>}
                  {!upgradable && upd && !upd.error && upd.latest && upd.current && (
                    <span className="shrink-0 text-2xs text-success/70">已是最新</span>
                  )}
                  {upd?.error && (
                    <span className="shrink-0 text-2xs text-ink-3" title={upd.error}>
                      检测失败
                    </span>
                  )}
                  {upgradable && (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busyName === p.name}
                      disabled={busyName === p.name}
                      onClick={() => void upgrade(p.name, upd?.latest ?? undefined)}
                    >
                      {busyName === p.name ? '升级中…' : '升级'}
                    </Button>
                  )}
                  <Button variant="danger" size="sm" disabled={busyName === p.name} onClick={() => void uninstall(p.name)}>
                    {busyName === p.name ? '处理中…' : '卸载'}
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* 推荐插件 */}
      <Card className="border-accent/20">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wider text-ink-2">推荐插件</h3>
          <Button
            variant="primary"
            size="sm"
            loading={installingAll}
            disabled={pendingCount === 0 || installingAll}
            onClick={() => void installAllRecommended()}
          >
            {installingAll ? '安装中…' : pendingCount === 0 ? '全部已安装' : '一键安装全部（' + pendingCount + '）'}
          </Button>
        </div>
        <p className="mt-1 text-xs text-ink-3">精选社区插件，覆盖搜索、视觉、计费、侧边栏、远程访问与右键菜单，一键补齐常用能力。</p>
        <div className="mt-3 space-y-1.5">
          {RECOMMENDED_PLUGINS.map((p) => {
            const done = isRecommendedInstalled(p)
            const busy = busyName === p.installTarget
            return (
              <div key={p.name} className="flex items-start gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm font-medium text-accent">{p.name}</span>
                    {p.defaultEnabled && <Badge tone="cyan">默认启用</Badge>}
                    <Badge tone={p.source === 'github' ? 'gray' : 'green'}>{p.source === 'github' ? 'GitHub' : 'npm'}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-2">{p.description}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void window.dshDesktop.app.openExternal(p.url)}>
                  主页
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy}
                  disabled={done || busy || installingAll}
                  onClick={() => void install(p.installTarget)}
                >
                  {busy ? '安装中…' : done ? '已安装' : '安装'}
                </Button>
              </div>
            )
          })}
        </div>
      </Card>

      {/* 社区目录 */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold tracking-wider text-ink-2">社区插件</h3>
          <div className="flex gap-2">
            <div className="relative">
              <IconSearch size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadCatalog(query)
                }}
                placeholder="搜索 dsh-plugin…"
                className="w-56 rounded-control border border-rule bg-surface-2 py-1.5 pl-7 pr-2.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-3 hover:border-rule-strong focus:border-accent/60"
              />
            </div>
            <Button variant="secondary" size="sm" loading={loadingCatalog} disabled={loadingCatalog} onClick={() => void loadCatalog(query)}>
              {loadingCatalog ? '搜索中…' : '搜索'}
            </Button>
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          {catalog.length === 0 && !loadingCatalog && (
            <EmptyState
              className="px-0 py-6"
              icon={<IconSearch size={30} />}
              title="未获取到插件列表"
              hint="GitHub topic dsh-plugin / npm keywords 为空或网络受限"
            />
          )}
          {catalog.map((p) => (
            <div
              key={p.source + '-' + p.packageName}
              className="flex items-start gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm font-medium text-accent">{p.packageName}</span>
                  <Badge tone={p.source === 'github' ? 'gray' : 'green'}>{p.source === 'github' ? 'GitHub' : 'npm'}</Badge>
                  {p.version && <span className="shrink-0 font-mono text-2xs text-ink-3">v{p.version}</span>}
                  {p.stars > 0 && <span className="shrink-0 font-mono text-2xs text-warning">★ {p.stars}</span>}
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{p.description || '暂无描述'}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (p.url) void window.dshDesktop.app.openExternal(p.url)
                }}
                title={p.url}
              >
                主页
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={busyName === p.packageName}
                disabled={isInstalled(p.packageName) || busyName === p.packageName}
                onClick={() => void install(p.packageName)}
              >
                {busyName === p.packageName ? '安装中…' : isInstalled(p.packageName) ? '已安装' : '安装'}
              </Button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}