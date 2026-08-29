import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppConfig,
  KernelInfo,
  KernelProgress,
  KernelQuota,
  KernelRemoteVersion,
  KernelUpdateInfo,
  RuntimeInfo
} from '../../../shared/types'
import { DEFAULT_KERNEL_VERSION } from '../../../shared/kernel-defaults'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Select } from '../ui/Field'
import { Card, Notice } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { IconBox } from '../ui/icons'

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
  // #5：内核安装源（空 = 官方 npmjs）
  const [registry, setRegistry] = useState('')
  // R-7: 运行时进度收尾定时器（卸载时清理）
  const rtTimerRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    setInstalled(await window.dshDesktop.kernels.installed())
    const c = await window.dshDesktop.config.get()
    setCfg(c)
    setRegistry(c.kernelRegistry ?? '')
    setRuntime(await window.dshDesktop.runtime.status())
    setQuota(await window.dshDesktop.kernels.quota())
  }, [])

  // R-6: 函数式更新，避免 selected 依赖导致切换下拉框触发 effect 连锁重跑（6+ 次 IPC + 整页刷新）
  const loadVersions = useCallback(async () => {
    const list = await window.dshDesktop.kernels.available()
    setAvailable(list)
    setSelected((prev) => prev || (list[0]?.version ?? ''))
  }, [])

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
        // R-7: timer 存 ref，卸载时清理（避免卸载后 setState + 多余 IPC）
        if (rtTimerRef.current !== null) window.clearTimeout(rtTimerRef.current)
        rtTimerRef.current = window.setTimeout(() => {
          rtTimerRef.current = null
          setRtProgress(null)
          void refresh()
        }, 800)
      }
    })
    return () => {
      off()
      offRt()
      if (rtTimerRef.current !== null) {
        window.clearTimeout(rtTimerRef.current)
        rtTimerRef.current = null
      }
    }
  }, [loadVersions, refresh])

  const install = async (): Promise<void> => {
    if (!selected) return
    setInstalling(selected)
    setMessage(null)
    const r = await window.dshDesktop.kernels.install(selected, registry || undefined)
    if (!r.ok) {
      setInstalling(null)
      setMessage({ type: 'err', text: r.error ?? '安装失败' })
    }
    // 成功时由 progress(done) 事件收尾
  }

  /** 保存安装源（#5） */
  const saveRegistry = async (v: string): Promise<void> => {
    setRegistry(v)
    await window.dshDesktop.config.set({ kernelRegistry: v })
    setMessage({ type: 'ok', text: v ? '安装源已切换为 ' + v : '安装源已切换为官方 npmjs' })
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
    const r = await window.dshDesktop.kernels.install(latest, registry || undefined)
    if (!r.ok) {
      setInstalling(null)
      setMessage({ type: 'err', text: r.error ?? '升级失败' })
      return
    }
    // R-1: 等待安装落盘并确认已安装后才设为默认（避免默认内核指向未安装版本）
    let installedOk = false
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 500))
      const inst = await window.dshDesktop.kernels.installed()
      if (inst.some((k) => k.version === latest && k.status === 'installed')) {
        installedOk = true
        break
      }
    }
    if (!installedOk) {
      setInstalling(null)
      setMessage({ type: 'err', text: '内核 v' + latest + ' 安装状态未确认（可能尚未落盘），未切换默认版本，请稍后重试' })
      await refresh()
      void window.dshDesktop.kernels.checkUpdate().then(setUpdate)
      return
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
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">DSH 内核（多版本共存）</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-ink-3">
              托管内核存放于 <code className="rounded bg-surface-2 px-1 py-px font-mono text-2xs text-accent">kernels/</code>
              ，各版本隔离、可并存切换。启动时默认使用「托管内核」；未安装任何托管内核时自动回退系统 dsh。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-2">模式</span>
            <Button
              variant={cfg?.kernelMode === 'managed' ? 'primary' : 'secondary'}
              onClick={() => void setMode(cfg?.kernelMode === 'managed' ? 'system' : 'managed')}
            >
              {cfg?.kernelMode === 'managed' ? '托管内核优先' : '始终用系统 dsh'}
            </Button>
          </div>
        </div>
      </Card>

      {/* 阶段 B：内置 Node 运行时 */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold tracking-wider text-ink-2">Node 运行时（内置）</h3>
            <p className="mt-1 max-w-xl text-xs text-ink-3">
              托管内核的原生模块（node-pty/sharp）需按 Node ABI 编译，不能使用 Electron 内置 Node。
              下载后全新机器无需安装 Node.js 即可运行（真零门槛）。
            </p>
          </div>
          {runtime && (
            <div className="flex shrink-0 items-center gap-2">
              {runtime.installed ? (
                <Button variant="danger" size="sm" loading={rtBusy} disabled={rtBusy} onClick={() => void removeRuntime()}>
                  {rtBusy ? '操作中…' : '删除'}
                </Button>
              ) : (
                <Button variant="primary" size="sm" loading={rtBusy} disabled={rtBusy} onClick={() => void downloadRuntime()}>
                  {rtBusy ? '下载中…' : '下载内置 Node 运行时'}
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="mt-3 space-y-1 text-xs text-ink-2">
          <div className="flex justify-between border-b border-rule/60 py-1">
            <span>内置 Node</span>
            <span className="font-mono text-ink">{runtime?.installed ? (runtime.version ?? '已安装') : '未安装'}</span>
          </div>
          <div className="flex justify-between border-b border-rule/60 py-1">
            <span>系统 Node（探测）</span>
            <span className="font-mono text-ink">{runtime?.systemNode ? runtime.systemNode : '未找到'}</span>
          </div>
        </div>
        {rtProgress && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-xs text-ink-2">
              <span>{rtProgress.message}</span>
              <span className="font-mono">{rtProgress.percent.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="progress-fill rounded-full bg-success"
                style={{ transform: `scaleX(${Math.min(100, rtProgress.percent) / 100})` }}
              />
            </div>
          </div>
        )}
      </Card>

      {/* 阶段 B：内核更新横幅 */}
      {update?.available && update.latest && (
        <section className="rounded-card border border-warning/30 bg-warning/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-warning">
              <span className="font-semibold">内核新版本可用：v{update.latest}</span>
              <span className="ml-2 text-xs text-warning/80">当前 v{update.current ?? '系统 dsh'}</span>
              {update.rc && update.rc !== update.latest && (
                <span className="ml-2 rounded bg-surface-2/60 px-1.5 py-px font-mono text-2xs text-ink-3">rc: v{update.rc}</span>
              )}
            </div>
            <Button variant="primary" loading={installing !== null} disabled={installing !== null} onClick={() => void upgrade()}>
              {installing !== null ? '升级中…' : '一键升级'}
            </Button>
          </div>
        </section>
      )}

      {/* 已安装版本 */}
      <Card>
        <h3 className="text-xs font-semibold tracking-wider text-ink-2">已安装（{installed.length}）</h3>
        {installed.length === 0 ? (
          <EmptyState
            className="px-0 py-6"
            icon={<IconBox size={30} />}
            title="尚未安装托管内核"
            hint={cfg?.kernelMode === 'managed' ? '当前使用系统 dsh，可在下方安装托管版本。' : '模式为「始终用系统 dsh」。'}
          />
        ) : (
          <div className="mt-3 space-y-1.5">
            {installed.map((k) => (
              <div key={k.version} className="flex items-center gap-3 rounded-control border border-rule/60 bg-canvas/50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-ink">v{k.version}</span>
                    {activeVersion === k.version && <Badge tone="cyan">● 当前默认</Badge>}
                    {k.status === 'error' && <Badge tone="red">安装异常</Badge>}
                  </div>
                  <div className="mt-0.5 font-mono text-2xs text-ink-3">
                    {fmtSize(k.size)} · {k.installedAt ? new Date(k.installedAt).toLocaleString() : '-'}
                  </div>
                </div>
                {activeVersion !== k.version && k.status !== 'error' && (
                  <Button
                    variant="accent"
                    size="sm"
                    loading={busyVersion === k.version}
                    disabled={busyVersion === k.version}
                    onClick={() => void setDefault(k.version)}
                  >
                    {busyVersion === k.version ? '切换中…' : '设为默认'}
                  </Button>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busyVersion === k.version || activeVersion === k.version}
                  onClick={() => void uninstall(k)}
                >
                  卸载
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 阶段 C：存储配额 */}
      <Card>
        <h3 className="text-xs font-semibold tracking-wider text-ink-2">存储配额</h3>
        <div className="mt-3 grid grid-cols-2 gap-2.5 text-xs text-ink-2 md:grid-cols-4">
          <div className="rounded-control bg-canvas/50 px-3 py-2">
            <div className="text-2xs text-ink-3">内核占用</div>
            <div className="mt-0.5 font-mono text-ink">{(quota?.usedMB ?? 0).toFixed(1)} MB</div>
          </div>
          <div className="rounded-control bg-canvas/50 px-3 py-2">
            <div className="text-2xs text-ink-3">Node 运行时</div>
            <div className="mt-0.5 font-mono text-ink">{(quota?.runtimeMB ?? 0).toFixed(1)} MB</div>
          </div>
          <div className="rounded-control bg-canvas/50 px-3 py-2">
            <div className="text-2xs text-ink-3">磁盘剩余</div>
            <div className="mt-0.5 font-mono text-ink">{(quota?.diskFreeMB ?? 0).toFixed(0)} MB</div>
          </div>
          <div className="rounded-control bg-canvas/50 px-3 py-2">
            <div className="text-2xs text-ink-3">配额上限</div>
            <div className="mt-0.5 flex items-center gap-1">
              <input
                type="number"
                min={0}
                value={quotaInput || String(cfg?.kernelsQuotaMB ?? 1024)}
                onChange={(e) => setQuotaInput(e.target.value)}
                onBlur={() => void saveQuota()}
                className="w-20 rounded border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink outline-none transition-colors hover:border-rule-strong focus:border-accent/60"
              />
              <span>MB（0 = 不限）</span>
            </div>
          </div>
        </div>
        {quota && quota.quotaMB > 0 && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className={`progress-fill rounded-full ${(quota.usedMB / quota.quotaMB) > 0.9 ? 'bg-danger' : 'bg-info'}`}
              style={{ transform: `scaleX(${Math.min(100, (quota.usedMB / quota.quotaMB) * 100) / 100})` }}
            />
          </div>
        )}
      </Card>

      {/* 安装新版本 */}
      <Card>
        <h3 className="text-xs font-semibold tracking-wider text-ink-2">安装新版本</h3>
        <div className="mt-3 flex gap-2">
          <Select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={installing !== null || available.length === 0}
            className="flex-1 font-mono"
          >
            {available.length === 0 && <option value="">（无法获取版本列表，检查网络）</option>}
            {available.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
                {installed.some((i) => i.version === v.version)
                  ? '（已安装）'
                  : v.version === DEFAULT_KERNEL_VERSION
                    ? '（推荐）'
                    : ''}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            loading={installing !== null}
            disabled={!selected || installing !== null || available.length === 0}
            onClick={() => void install()}
          >
            {installing !== null ? '安装中…' : '安装'}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-3">安装源</span>
          <Select value={registry} onChange={(e) => void saveRegistry(e.target.value)} disabled={installing !== null} className="w-72 font-mono text-xs">
            <option value="">官方 npmjs（默认）</option>
            <option value="https://registry.npmmirror.com">npmmirror（国内加速）</option>
          </Select>
          <span className="text-2xs text-ink-3">保存后后续安装/升级均使用该源</span>
        </div>

        {progress && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-ink-2">
              <span>安装 v{progress.version}</span>
              <span className="font-mono">{progress.percent.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="progress-fill rounded-full bg-accent"
                style={{ transform: `scaleX(${Math.min(100, progress.percent) / 100})` }}
              />
            </div>
            <div className="mt-1 text-2xs text-ink-3">{progress.message}</div>
          </div>
        )}

        {message && (
          <div className="mt-3">
            <Notice tone={message.type}>{message.text}</Notice>
          </div>
        )}
      </Card>
    </div>
  )
}
