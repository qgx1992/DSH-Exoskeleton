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

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`
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
  const [appVersion, setAppVersion] = useState('')
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
      window.dshDesktop.runtime.status(),
      window.dshDesktop.app.getVersion()
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
    setAppVersion(val<string>(9) ?? '')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const running = state?.status === 'running'
  const starting = state?.status === 'starting'
  const updatablePlugins = plugins.filter((p) => p.update?.available).length
  const errorLogs = logs.filter((l) => l.level === 'error').length
  const warnLogs = logs.filter((l) => l.level === 'warn').length
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* 服务状态 + 快捷操作 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">总览</h2>
            <p className="mt-1 text-[12px] text-slate-500">
              {running
                ? `DSH 服务运行中 · 127.0.0.1:${state?.port ?? '-'}`
                : starting
                  ? 'DSH 服务启动中…'
                  : state?.status === 'error'
                    ? 'DSH 服务异常'
                    : 'DSH 服务已停止'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!running ? (
              <button
                onClick={onStart}
                disabled={starting}
                className="rounded-lg bg-cyan-500 px-4 py-1.5 text-[13px] font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-50"
              >
                {starting ? '启动中…' : '启动服务'}
              </button>
            ) : (
              <>
                <button
                  onClick={onStop}
                  className="rounded-lg bg-red-500/20 px-3 py-1.5 text-[13px] font-medium text-red-300 transition-colors hover:bg-red-500/30"
                >
                  停止
                </button>
                <button
                  onClick={onRestart}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-[13px] font-medium text-slate-200 transition-colors hover:bg-slate-700"
                >
                  重启
                </button>
              </>
            )}
            <button
              onClick={onOpenWebUI}
              disabled={!running}
              className="rounded-lg bg-cyan-500 px-4 py-1.5 text-[13px] font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
            >
              打开 Web UI
            </button>
            {webUrl && (
              <button
                onClick={() => void copyUrl()}
                className="rounded-lg bg-slate-800 px-3 py-1.5 text-[12px] text-slate-300 transition-colors hover:bg-slate-700"
                title={webUrl}
              >
                {copied ? '✓ 已复制' : '复制地址'}
              </button>
            )}
          </div>
        </div>
        {state?.lastError && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {state.lastError}
          </div>
        )}
      </section>

      {/* 汇总卡片 */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard
          label="DSH 内核"
          value={kernels.length > 0 ? `${kernels.length} 个` : '未安装'}
          sub={cfg?.defaultKernelVersion ? `默认 v${cfg.defaultKernelVersion}` : '使用系统 dsh'}
          badge={
            kernelUpdate?.available && kernelUpdate.latest
              ? { text: `可升级 v${kernelUpdate.latest}`, tone: 'amber' }
              : undefined
          }
        />
        <SummaryCard
          label="已装插件"
          value={`${plugins.length} 个`}
          sub={updatablePlugins > 0 ? `${updatablePlugins} 个可升级` : '全部最新'}
          badge={
            updatablePlugins > 0
              ? { text: `${updatablePlugins} 可升级`, tone: 'amber' }
              : undefined
          }
        />
        <SummaryCard
          label="备份快照"
          value={`${backups.length} 个`}
          sub={backups.length > 0 ? `最近 ${fmtRelative(backups[0].createdAt)}` : '暂无快照'}
        />
        <SummaryCard
          label="会话"
          value={`${sessions.length} 个`}
          sub={sessions.length > 0 ? `最近 ${fmtRelative(sessions[0].modifiedAt)}` : '暂无会话'}
        />
        <SummaryCard
          label="日志"
          value={`${errorLogs + warnLogs} 条告警`}
          sub={errorLogs > 0 ? `${errorLogs} 条错误` : '最近无错误'}
          badge={errorLogs > 0 ? { text: '有错误', tone: 'red' } : undefined}
        />
        <SummaryCard
          label="磁盘占用"
          value={quota ? `${quota.usedMB.toFixed(0)} MB` : '…'}
          sub={quota ? `剩余 ${quota.diskFreeMB.toFixed(0)} MB` : '查询中…'}
          badge={quota && quota.quotaMB > 0 && quota.usedMB / quota.quotaMB > 0.9 ? { text: '配额紧张', tone: 'red' } : undefined}
        />
        <SummaryCard
          label="Node 运行时"
          value={runtime?.installed ? runtime.version ?? '已安装' : '未安装'}
          sub={runtime?.installed ? '内置（见「内核」页）' : '使用系统 Node'}
        />
        <SummaryCard
          label="配置档案"
          value={cfg?.activeProfileId ?? 'default'}
          sub={cfg?.profiles?.length ? `${cfg.profiles.length} 个档案` : ''}
        />
      </section>

      {/* 最近会话 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">最近会话</h3>
          <span className="text-[11px] text-slate-600">点击在 Web UI 中打开</span>
        </div>
        {sessions.length === 0 ? (
          <div className="mt-3 text-[13px] text-slate-500">暂无会话（会话数据保存在 ~/.dsh/sessions）</div>
        ) : (
          <div className="mt-3 space-y-2">
            {sessions.map((s) => (
              <button
                key={s.uuid}
                onClick={() => void openSession(s)}
                className="flex w-full items-center gap-3 rounded-lg border border-slate-800/70 bg-slate-900/50 px-3 py-2 text-left transition-colors hover:border-cyan-500/40 hover:bg-slate-900"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-slate-200">{s.title}</span>
                    {s.project && (
                      <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-px text-[10px] text-slate-400">{s.project}</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-500">{s.firstUserText || s.uuid}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[11px] text-slate-400">{fmtRelative(s.modifiedAt)}</div>
                  <div className="text-[10px] text-slate-600">{fmtSize(s.size)}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 快速入口说明 */}
      <section className="rounded-xl border border-slate-800/70 bg-[#0d111a] p-6 text-[13px] leading-relaxed text-slate-400">
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-slate-500">
          管理面板 · DSH-Exoskeleton v{appVersion || '-'}
        </h3>
        <ul className="list-inside list-disc space-y-1.5">
          <li>「会话」页可搜索、导出、删除本地会话。</li>
          <li>「内核 / 插件 / 备份 / 日志 / 更新」按需管理运行时与数据。</li>
          <li>最近修改时间：{backups.length > 0 ? fmtTime(backups[0].createdAt) : '-'} 有备份记录。</li>
        </ul>
      </section>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  sub,
  badge
}: {
  label: string
  value: string
  sub?: string
  badge?: { text: string; tone: 'amber' | 'red' }
}): React.JSX.Element {
  const tone =
    badge?.tone === 'red'
      ? 'border-red-500/40 bg-red-500/10 text-red-300'
      : 'border-amber-400/40 bg-amber-400/10 text-amber-300'
  return (
    <div className="rounded-xl border border-slate-800 bg-[#0d111a] p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-slate-500">{label}</div>
        {badge && <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] ${tone}`}>{badge.text}</span>}
      </div>
      <div className="mt-1 truncate text-[16px] font-semibold text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}
