import { useCallback, useEffect, useState } from 'react'
import type {
  AppConfig,
  BackupInfo,
  DSHState,
  InstalledPlugin,
  KernelInfo,
  KernelQuota,
  KernelUpdateInfo,
  LogEntry,
  RuntimeInfo,
  SessionInfo
} from '../../../shared/types'
import { Button } from '../ui/Button'
import { Badge, type BadgeTone } from '../ui/Badge'
import { StatusDot } from '../ui/StatusDot'
import { Card, Notice } from '../ui/Card'

interface Props {
  state: DSHState | null
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  /** 关闭管理面板，回到 DSH Web UI */
  onOpenWebUI: () => void
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function fmtRelative(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const h = Math.floor(min / 60)
  if (h < 24) return h + ' 小时前'
  const d = Math.floor(h / 24)
  if (d < 30) return d + ' 天前'
  return new Date(ms).toLocaleDateString()
}

export function OverviewTab({ state, onStart, onStop, onRestart, onOpenWebUI }: Props): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [kernels, setKernels] = useState<KernelInfo[]>([])
  const [kernelUpdate, setKernelUpdate] = useState<KernelUpdateInfo | null>(null)
  const [quota, setQuota] = useState<KernelQuota | null>(null)
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    // 单个数据源失败不应拖垮整个总览：分别取成功的部分，失败保持上次/空值
    const results = await Promise.allSettled([
      window.dshDesktop.config.get(),
      window.dshDesktop.kernels.installed(),
      window.dshDesktop.kernels.checkUpdate(),
      window.dshDesktop.kernels.quota(),
      window.dshDesktop.plugins.installed(),
      window.dshDesktop.backup.list(),
      window.dshDesktop.logs.list(300),
      window.dshDesktop.sessions.list(6),
      window.dshDesktop.runtime.status()
    ])
    const val = <T,>(i: number): T | null => (results[i]?.status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<T>).value : null)
    setCfg(val<AppConfig>(0))
    setKernels(val<KernelInfo[]>(1) ?? [])
    setKernelUpdate(val<KernelUpdateInfo>(2))
    setQuota(val<KernelQuota>(3))
    setPlugins(val<InstalledPlugin[]>(4) ?? [])
    setBackups(val<BackupInfo[]>(5) ?? [])
    setLogs(val<LogEntry[]>(6) ?? [])
    setSessions(val<SessionInfo[]>(7) ?? [])
    setRuntime(val<RuntimeInfo>(8))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const running = state?.status === 'running'
  const starting = state?.status === 'starting'
  const updatablePlugins = plugins.filter((p) => p.update?.available).length
  const errorLogs = logs.filter((l) => l.level === 'error').length
  const webUrl = state?.webUrl ?? (state?.port ? `http://127.0.0.1:${state.port}` : null)

  const copyUrl = async (): Promise<void> => {
    if (!webUrl) return
    await window.dshDesktop.app.copyText(webUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const openSession = async (s: SessionInfo): Promise<void> => {
    const r = await window.dshDesktop.sessions.open(s.uuid)
    if (r.ok) onOpenWebUI()
  }

  const statusLabel = running ? '服务运行中' : starting ? '服务启动中' : state?.status === 'error' ? '服务异常' : '服务已停止'
  const heroMeta = running
    ? `DSH v${state?.version ?? '-'} · Web UI 就绪`
    : starting
      ? '正在拉起 dsh web…'
      : state?.status === 'error'
        ? '查看下方错误信息'
        : '启动后主区域将显示 DSH Web UI'

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {/* 主状态卡：服务状态 + 快捷操作（每屏唯一 primary） */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              {running ? (
                <span
                  className="inline-block size-3 shrink-0 rounded-full bg-success"
                  style={{
                    boxShadow:
                      '0 0 0 5px color-mix(in oklab, var(--color-success) 14%, transparent), 0 0 22px 2px color-mix(in oklab, var(--color-success) 22%, transparent)'
                  }}
                />
              ) : (
                <StatusDot status={state?.status ?? 'starting'} />
              )}
              <h2 className="text-lg font-semibold tracking-tight text-ink">{statusLabel}</h2>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {webUrl && (
                <span className="rounded bg-info/10 px-1.5 py-0.5 font-mono text-2xs text-info" title={webUrl}>
                  {webUrl}
                </span>
              )}
              {webUrl && (
                <Button variant={copied ? 'success' : 'ghost'} size="sm" onClick={() => void copyUrl()}>
                  {copied ? '✓ 已复制' : '复制地址'}
                </Button>
              )}
              <span className="text-xs text-ink-3">{heroMeta}</span>
            </div>
            {state?.lastError && (
              <div className="mt-3 max-w-xl">
                <Notice tone="err">{state.lastError}</Notice>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!running ? (
              <Button variant="primary" loading={starting} disabled={starting} onClick={onStart}>
                {starting ? '启动中…' : '启动服务'}
              </Button>
            ) : (
              <>
                <Button variant="danger" onClick={onStop}>
                  停止
                </Button>
                <Button variant="secondary" onClick={onRestart}>
                  重启
                </Button>
              </>
            )}
            <Button variant="primary" disabled={!running} onClick={onOpenWebUI}>
              打开 Web UI
            </Button>
          </div>
        </div>
      </Card>

      {/* 汇总卡片 2×3 */}
      <section className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
        <StatCard
          label="DSH 内核"
          value={kernels.length > 0 ? String(kernels.length) : '未安装'}
          unit={kernels.length > 0 ? '个' : undefined}
          sub={cfg?.defaultKernelVersion ? `默认 v${cfg.defaultKernelVersion}` : '使用系统 dsh'}
          badge={
            kernelUpdate?.available && kernelUpdate.latest
              ? { text: `可升级 v${kernelUpdate.latest}`, tone: 'amber' }
              : undefined
          }
        />
        <StatCard
          label="已装插件"
          value={String(plugins.length)}
          unit="个"
          sub={updatablePlugins > 0 ? `${updatablePlugins} 个可升级` : '全部最新'}
          badge={updatablePlugins > 0 ? { text: `${updatablePlugins} 可升级`, tone: 'amber' } : undefined}
        />
        <StatCard
          label="备份快照"
          value={String(backups.length)}
          unit="个"
          sub={backups.length > 0 ? `最近 ${fmtRelative(backups[0].createdAt)}` : '暂无快照'}
        />
        <StatCard
          label="会话"
          value={String(sessions.length)}
          unit="个"
          sub={sessions.length > 0 ? `最近 ${fmtRelative(sessions[0].modifiedAt)}` : '暂无会话'}
        />
        <StatCard
          label="日志告警"
          value={String(logs.filter((l) => l.level === 'warn' || l.level === 'error').length)}
          unit="条"
          sub={errorLogs > 0 ? `${errorLogs} 条错误` : '最近无错误'}
          badge={errorLogs > 0 ? { text: '有错误', tone: 'red' } : undefined}
        />
        <StatCard
          label="磁盘占用"
          value={quota ? quota.usedMB.toFixed(0) : '…'}
          unit={quota ? 'MB' : undefined}
          sub={quota ? `剩余 ${quota.diskFreeMB.toFixed(0)} MB` : '查询中…'}
          badge={
            quota && quota.quotaMB > 0 && quota.usedMB / quota.quotaMB > 0.9 ? { text: '配额紧张', tone: 'red' } : undefined
          }
        />
        <StatCard
          label="Node 运行时"
          value={runtime?.installed ? runtime.version ?? '已安装' : '未安装'}
          sub={runtime?.installed ? '内置（见「内核」页）' : '使用系统 Node'}
        />
        <StatCard
          label="配置档案"
          value={cfg?.activeProfileId ?? 'default'}
          sub={cfg?.profiles?.length ? `${cfg.profiles.length} 个档案` : undefined}
        />
      </section>

      {/* 最近会话 */}
      <Card>
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold tracking-wider text-ink-2">最近会话</h3>
          <span className="text-2xs text-ink-3">点击在 Web UI 中打开</span>
        </div>
        {sessions.length === 0 ? (
          <div className="text-sm text-ink-3">暂无会话（会话数据保存在 ~/.dsh/sessions）</div>
        ) : (
          <div className="space-y-1.5">
            {sessions.map((s) => (
              <button
                key={s.uuid}
                onClick={() => void openSession(s)}
                className="flex w-full items-center gap-3 rounded-control border border-transparent bg-canvas/50 px-3 py-2 text-left transition-colors duration-150 hover:border-accent/25 hover:bg-surface-2"
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
                </div>
                <div className="shrink-0 text-right font-mono">
                  <div className="text-2xs text-ink-2">{fmtRelative(s.modifiedAt)}</div>
                  <div className="text-2xs text-ink-3">{fmtSize(s.size)}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function StatCard({
  label,
  value,
  unit,
  sub,
  badge
}: {
  label: string
  value: string
  unit?: string
  sub?: string
  badge?: { text: string; tone: BadgeTone }
}): React.JSX.Element {
  return (
    <div className="rounded-card border border-rule bg-surface p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-2">{label}</span>
        {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
      </div>
      <div className="mt-0.5 truncate font-mono text-lg font-semibold tracking-tight text-ink">
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-ink-3">{unit}</span>}
      </div>
      {sub && <div className="mt-px truncate text-xs text-ink-3">{sub}</div>}
    </div>
  )
}
