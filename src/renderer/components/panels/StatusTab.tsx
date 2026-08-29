import { useEffect, useState } from 'react'
import type { DSHState } from '../../../shared/types'

interface Props {
  state: DSHState | null
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}

const STATUS_LABEL: Record<string, { text: string; color: string; badge: string }> = {
  running: { text: '运行中', color: 'text-cyan-300', badge: 'bg-cyan-500/15 border-cyan-500/30' },
  starting: { text: '启动中', color: 'text-slate-300', badge: 'bg-slate-500/15 border-slate-500/30' },
  stopped: { text: '已停止', color: 'text-slate-400', badge: 'bg-slate-700/20 border-slate-600/40' },
  error: { text: '异常', color: 'text-red-400', badge: 'bg-red-500/15 border-red-500/30' }
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
  const status = state ? (STATUS_LABEL[state.status] ?? STATUS_LABEL.stopped) : STATUS_LABEL.starting

  useEffect(() => {
    void window.dshDesktop.app.getDshHome().then(setDshHome)
  }, [])

  const running = state?.status === 'running'
  const starting = state?.status === 'starting'

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* 服务状态卡片 */}
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">DSH 服务</h2>
            <p className="mt-1 text-[12px] text-slate-500">DeepSeek Harness Web 服务（dsh web）</p>
          </div>
          <span className={`rounded-full border px-3 py-1 text-[12px] font-medium ${status.badge} ${status.color}`}>
            {status.text}
          </span>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
          <div className="flex justify-between border-b border-slate-800/60 py-1.5">
            <dt className="text-slate-500">监听地址</dt>
            <dd className="font-mono text-slate-200">{state?.port ? `127.0.0.1:${state.port}` : '-'}</dd>
          </div>
          <div className="flex justify-between border-b border-slate-800/60 py-1.5">
            <dt className="text-slate-500">Web UI 地址</dt>
            <dd className="max-w-[60%] truncate font-mono text-slate-200" title={state?.webUrl ?? ''}>
              {state?.webUrl ?? (state?.port ? `http://127.0.0.1:${state.port}` : '-')}
            </dd>
          </div>
          <div className="flex justify-between border-b border-slate-800/60 py-1.5">
            <dt className="text-slate-500">DSH 内核版本</dt>
            <dd className="font-mono text-slate-200">{state?.version ?? '查询中…'}</dd>
          </div>
          <div className="flex justify-between border-b border-slate-800/60 py-1.5">
            <dt className="text-slate-500">进程 PID</dt>
            <dd className="font-mono text-slate-200">{state?.pid ?? '-'}</dd>
          </div>
          <div className="flex justify-between border-b border-slate-800/60 py-1.5">
            <dt className="text-slate-500">运行时长</dt>
            <dd className="font-mono text-slate-200">{fmtUptime(state?.startedAt ?? null)}</dd>
          </div>
          <div className="flex justify-between border-b border-slate-800/60 py-1.5">
            <dt className="text-slate-500">崩溃重启次数</dt>
            <dd className="font-mono text-slate-200">{state?.restartCount ?? 0}</dd>
          </div>
          <div className="flex justify-between border-b border-slate-800/60 py-1.5">
            <dt className="text-slate-500">数据目录（DSH Home）</dt>
            <dd className="max-w-[60%] truncate font-mono text-slate-200" title={dshHome ?? ''}>
              {dshHome ?? '-'}
            </dd>
          </div>
        </dl>

        {state?.lastError && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {state.lastError}
          </div>
        )}

        <div className="mt-5 flex gap-2">
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
                className="rounded-lg bg-red-500/20 px-4 py-1.5 text-[13px] font-medium text-red-300 transition-colors hover:bg-red-500/30"
              >
                停止服务
              </button>
              <button
                onClick={onRestart}
                className="rounded-lg bg-slate-800 px-4 py-1.5 text-[13px] font-medium text-slate-200 transition-colors hover:bg-slate-700"
              >
                重启服务
              </button>
            </>
          )}
        </div>
      </section>

      {/* 说明卡片 */}
      <section className="rounded-xl border border-slate-800/70 bg-[#0d111a] p-6 text-[13px] leading-relaxed text-slate-400">
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-slate-500">使用提示</h3>
        <ul className="list-inside list-disc space-y-1.5">
          <li>服务运行后，主区域自动显示 DSH Web UI。</li>
          <li>关闭窗口 = 隐藏到系统托盘，应用常驻后台。</li>
          <li>右键系统托盘图标可快速启动 / 停止服务、设置开机自启。</li>
          <li>数据默认复用 ~/.dsh 目录，已有配置零迁移。</li>
        </ul>
      </section>
    </div>
  )
}