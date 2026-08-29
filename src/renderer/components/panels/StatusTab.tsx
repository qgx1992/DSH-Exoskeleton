import { useEffect, useState } from 'react'
import type { DSHState } from '../../../shared/types'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { StatusDot } from '../ui/StatusDot'

interface Props {
  state: DSHState | null
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}

const STATUS_META: Record<string, { text: string; badge: string }> = {
  running: { text: '运行中', badge: 'border-success/30 bg-success/10 text-success' },
  starting: { text: '启动中', badge: 'border-info/30 bg-info/10 text-info' },
  stopped: { text: '已停止', badge: 'border-rule bg-surface-2 text-ink-2' },
  error: { text: '异常', badge: 'border-danger/30 bg-danger/10 text-danger' }
}

function fmtUptime(ms: number | null): string {
  if (!ms) return '-'
  const s = Math.floor((Date.now() - ms) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}时${m}分${sec}秒` : m > 0 ? `${m}分${sec}秒` : `${sec}秒`
}

export function StatusTab({ state, onStart, onStop, onRestart }: Props): React.JSX.Element {
  const [dshHome, setDshHome] = useState<string | null>(null)
  const status = state ? (STATUS_META[state.status] ?? STATUS_META.stopped) : STATUS_META.starting

  useEffect(() => {
    void window.dshDesktop.app.getDshHome().then(setDshHome)
  }, [])

  const running = state?.status === 'running'
  const starting = state?.status === 'starting'

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* 服务状态卡片 */}
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">DSH 服务</h2>
            <p className="mt-1 text-xs text-ink-3">DeepSeek Harness Web 服务（dsh web）</p>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-chip border px-2.5 py-0.5 text-xs font-medium ${status.badge}`}>
            <StatusDot status={state?.status ?? 'starting'} />
            {status.text}
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
          {(
            [
              ['监听地址', state?.port ? `127.0.0.1:${state.port}` : '-'],
              ['Web UI 地址', state?.webUrl ?? (state?.port ? `http://127.0.0.1:${state.port}` : '-')],
              ['DSH 内核版本', state?.version ?? '查询中…'],
              ['进程 PID', String(state?.pid ?? '-')],
              ['运行时长', fmtUptime(state?.startedAt ?? null)],
              ['崩溃重启次数', String(state?.restartCount ?? 0)],
              ['数据目录（DSH Home）', dshHome ?? '-']
            ] as [string, string][]
          ).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3 border-b border-rule/60 py-1.5">
              <dt className="shrink-0 text-xs text-ink-3">{k}</dt>
              <dd className="truncate font-mono text-xs text-ink" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>

        {state?.lastError && (
          <div className="mt-4 rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger selectable">
            {state.lastError}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          {!running ? (
            <Button variant="primary" loading={starting} disabled={starting} onClick={onStart}>
              {starting ? '启动中…' : '启动服务'}
            </Button>
          ) : (
            <>
              <Button variant="danger" onClick={onStop}>
                停止服务
              </Button>
              <Button variant="secondary" onClick={onRestart}>
                重启服务
              </Button>
            </>
          )}
        </div>
      </Card>

      {/* 使用提示 */}
      <Card>
        <h3 className="text-xs font-semibold tracking-wider text-ink-2">使用提示</h3>
        <ul className="mt-2 list-inside list-disc space-y-1.5 text-sm leading-relaxed text-ink-2">
          <li>服务运行后，主区域自动显示 DSH Web UI。</li>
          <li>关闭窗口 = 隐藏到系统托盘，应用常驻后台。</li>
          <li>右键系统托盘图标可快速启动 / 停止服务、设置开机自启。</li>
          <li>数据默认复用 ~/.dsh 目录，已有配置零迁移。</li>
        </ul>
      </Card>
    </div>
  )
}
