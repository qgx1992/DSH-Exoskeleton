import { useState } from 'react'
import type { UpdateInfo } from '../../../shared/types'

export function UpdateTab(): React.JSX.Element {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      const result = await window.dshDesktop.updater.check()
      setInfo(result)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h2 className="text-lg font-semibold text-slate-100">自动更新</h2>
        <p className="mt-1 text-[12px] text-slate-500">
          检查 DeepSeek Harness 官方仓库的最新发布版本。完整静默更新将在后续阶段接入。
        </p>

        <div className="mt-5 flex items-center gap-3">
          <button
            onClick={() => void check()}
            disabled={checking}
            className="rounded-lg bg-cyan-500 px-4 py-1.5 text-[13px] font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-50"
          >
            {checking ? '检查中…' : '检查更新'}
          </button>
        </div>

        {info && (
          <div className="mt-5 space-y-2 text-[13px]">
            <div className="flex justify-between border-b border-slate-800/60 py-1.5">
              <span className="text-slate-500">当前版本</span>
              <span className="font-mono text-slate-200">{info.current}</span>
            </div>
            <div className="flex justify-between border-b border-slate-800/60 py-1.5">
              <span className="text-slate-500">最新版本</span>
              <span className="font-mono text-slate-200">{info.latest ?? '未知'}</span>
            </div>
            {info.available && info.url && (
              <button
                onClick={() => void window.dshDesktop.app.openExternal(info.url as string)}
                className="mt-2 rounded-lg bg-slate-800 px-3 py-1.5 text-[13px] text-cyan-300 hover:bg-slate-700"
              >
                前往发布页下载 ↗
              </button>
            )}
            {info.error && <div className="text-[12px] text-amber-400">检查失败：{info.error}</div>}
          </div>
        )}
      </section>
    </div>
  )
}