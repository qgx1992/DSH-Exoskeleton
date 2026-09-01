import { useCallback, useEffect, useState } from 'react'
import type { InstalledPlugin, PluginCatalogItem } from '../../../shared/types'
import { RECOMMENDED_PLUGINS, type RecommendedPlugin } from '../../../shared/recommended-plugins'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Card, Notice } from '../ui/Card'
import { RowNotice, type RowMessage } from '../ui/RowNotice'
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
  const [message, setMessage] = useState<RowMessage | null>(null)
  /** 行内结果提示（key = 插件 name / installTarget）：操作结果跟随触发它的插件行，
   *  而非页面顶/底横幅（长列表里看不到反馈）；顶部全量操作（检查更新/一键安装）仍用 message */
  const [rowMsg, setRowMsg] = useState<Record<string, RowMessage | null>>({})
  const setRow = (key: string, m: RowMessage | null): void => {
    setRowMsg((prev) => ({ ...prev, [key]: m }))
  }

  const [recBusy, setRecBusy] = useState<string | null>(null)
  /** 用户自定义推荐（config.customRecommendedPlugins）；与内置精选合并展示在推荐区 */
  const [customRecs, setCustomRecs] = useState<RecommendedPlugin[]>([])
  const refreshCustomRecs = useCallback(async (): Promise<void> => {
    const cfg = await window.dshDesktop.config.get()
    setCustomRecs(cfg.customRecommendedPlugins ?? [])
  }, [])

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
    void refreshCustomRecs()
  }, [loadCatalog, refreshCustomRecs, refreshInstalled])

  const isInstalled = (pkg: string): boolean => installed.some((i) => i.name === pkg)
  const isRecommendedInstalled = (p: RecommendedPlugin): boolean => installed.some((i) => i.name === p.name)

  /** 推荐区数据源 = 内置精选 + 用户自定义（按 name 去重，内置优先） */
  const allRecommended: RecommendedPlugin[] = [
    ...RECOMMENDED_PLUGINS,
    ...customRecs.filter((c) => !RECOMMENDED_PLUGINS.some((r) => r.name === c.name))
  ]
  const isCustomRecommended = (name: string): boolean => customRecs.some((c) => c.name === name)
  const isRecommendedAnywhere = (name: string): boolean => allRecommended.some((r) => r.name === name)

  /** 加入推荐：写入自定义推荐列表，结果就地显示在该插件行 */
  const addRecommend = async (name: string): Promise<void> => {
    setRecBusy(name)
    setRow(name, null)
    try {
      const r = await window.dshDesktop.plugins.recommend(name)
      setRow(name, r.ok ? { type: 'ok', text: '已加入推荐列表（见下方「推荐插件」区）' } : { type: 'err', text: r.error ?? '加入推荐失败' })
      await refreshCustomRecs()
    } finally {
      setRecBusy(null)
    }
  }

  /** 移出推荐：仅自定义项可移除，结果就地显示在推荐区该行 */
  const removeRecommend = async (p: RecommendedPlugin): Promise<void> => {
    setRecBusy(p.name)
    setRow('rec:' + p.name, null)
    try {
      const r = await window.dshDesktop.plugins.unrecommend(p.name)
      setRow('rec:' + p.name, r.ok ? { type: 'ok', text: '已移出推荐列表' } : { type: 'err', text: r.error ?? '移出失败' })
      await refreshCustomRecs()
    } finally {
      setRecBusy(null)
    }
  }

  const install = async (pkg: string): Promise<void> => {
    setBusyName(pkg)
    setRow(pkg, null)
    try {
      const r = await window.dshDesktop.plugins.install(pkg)
      setRow(pkg, r.ok ? { type: 'ok', text: '已安装（安装前已自动备份）' } : { type: 'err', text: r.error ?? '安装失败' })
      await refreshInstalled()
    } finally {
      setBusyName(null)
    }
  }

  const installAllRecommended = async (): Promise<void> => {
    const todo = allRecommended.filter((p) => !isRecommendedInstalled(p))
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
    setRow(name, null)
    try {
      const r = await window.dshDesktop.plugins.uninstall(name)
      setRow(name, r.ok ? { type: 'ok', text: '已卸载（卸载前已自动备份）' } : { type: 'err', text: r.error ?? '卸载失败' })
      await refreshInstalled()
    } finally {
      setBusyName(null)
    }
  }

  const upgrade = async (name: string, latest?: string): Promise<void> => {
    setBusyName(name)
    setRow(name, null)
    try {
      const r = await window.dshDesktop.plugins.upgrade(name, latest)
      setRow(name, r.ok ? { type: 'ok', text: '已升级到 v' + (latest ?? 'latest') + '（升级前已自动备份）' } : { type: 'err', text: r.error ?? '升级失败' })
      // 升级成功后静默重检，让「有新版本」徽标即时归零
      if (r.ok) await refreshUpdates()
    } finally {
      setBusyName(null)
    }
  }

  const pendingCount = allRecommended.filter((p) => !isRecommendedInstalled(p)).length

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
                <div key={p.name}>
                  <div className="flex items-center gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2">
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
                  {/* 当前内核的兼容补丁停用了该插件（装了但不加载）：显式标出并悬停说明，
                      避免“装了看不到效果”被误判为安装失败 */}
                  {p.compatDisabled && (
                    <Badge tone="amber" title={p.compatDisabled}>
                      已停用
                    </Badge>
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
                  {/* 已安装 → 一键加入推荐（内置精选/已在列表则显示禁用态） */}
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={recBusy === p.name}
                    disabled={recBusy !== null || busyName === p.name || isRecommendedAnywhere(p.name)}
                    onClick={() => void addRecommend(p.name)}
                    title={isRecommendedAnywhere(p.name) ? '已在推荐列表中' : '加入推荐列表，展示在下方「推荐插件」区'}
                  >
                    {recBusy === p.name ? '加入中…' : isRecommendedAnywhere(p.name) ? '已推荐' : '加入推荐'}
                  </Button>
                  <Button variant="danger" size="sm" disabled={busyName === p.name} onClick={() => void uninstall(p.name)}>
                    {busyName === p.name ? '处理中…' : '卸载'}
                  </Button>
                  </div>
                  <RowNotice msg={rowMsg[p.name]} />
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
          {allRecommended.map((p) => {
            const done = isRecommendedInstalled(p)
            const busy = busyName === p.installTarget
            const custom = isCustomRecommended(p.name)
            return (
              <div key={p.name}>
              <div className="flex items-start gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm font-medium text-accent">{p.name}</span>
                    {p.defaultEnabled && <Badge tone="cyan">默认启用</Badge>}
                    {custom && <Badge tone="gray" title="由你在「已安装」列表加入推荐">自定义</Badge>}
                    <Badge tone={p.source === 'github' ? 'gray' : p.source === 'local' ? 'gray' : 'green'}>
                      {p.source === 'github' ? 'GitHub' : p.source === 'local' ? '本地' : 'npm'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-2">{p.description}</p>
                </div>
                <Button variant="ghost" size="sm" disabled={!p.url} onClick={() => void window.dshDesktop.app.openExternal(p.url)}>
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
                {/* 自定义推荐可移出（内置精选不可移除） */}
                {custom && (
                  <Button
                    variant="danger"
                    size="sm"
                    loading={recBusy === p.name}
                    disabled={recBusy !== null}
                    onClick={() => void removeRecommend(p)}
                    title="从推荐列表移除（不会卸载插件）"
                  >
                    移出推荐
                  </Button>
                )}
              </div>
              <RowNotice msg={rowMsg[p.installTarget] ?? rowMsg['rec:' + p.name]} />
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
            <div key={p.source + '-' + p.packageName}>
              <div className="flex items-start gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2">
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
              <RowNotice msg={rowMsg[p.packageName]} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}