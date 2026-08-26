import { useEffect, useState } from 'react'
import type { UpdateInfo } from '../../../shared/types'

interface DownloadingState {
  percent: number
  transferred: number
  total: number
}

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function UpdateTab(): React.JSX.Element {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState<DownloadingState | null>(null)
  const [downloaded, setDownloaded] = useState(false)

  useEffect(() => {
    // 订阅主进程更新状态（下载进度 / 下载完成 / 后台检查结果）
    const off = window.dshDesktop.updater.onStatus((u) => {
      setInfo(u)
      if (u.progress && u.progress.percent < 100) {
        setDownloading(u.progress)
        setDownloaded(false)
      } else if (u.downloaded) {
        setDownloading(null)
        setDownloaded(true)
      }
    })
    // R-30: 移除挂载即自动网络检查（改为用户手动点击「检查更新」触发）
    return () => {
      off()
    }
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      const result = await window.dshDesktop.updater.check()
      setInfo(result)
    } finally {
      setChecking(false)
    }
  }

  const install = (): void => {
    void window.dshDesktop.updater.install()
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h2 className="text-lg font-semibold text-slate-100">自动更新</h2>
        <p className="mt-1 text-[12px] text-slate-500">
          NSIS 安装版：后台静默检查并下载，就绪后提示一键重启安装；便携版/开发版提供下载页引导。
        </p>

        <div className="mt-5 flex items-center gap-3">
          <button
            onClick={() => void check()}
            disabled={checking}
            className="rounded-lg bg-amber-400 px-4 py-1.5 text-[13px] font-medium text-slate-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
          >
            {checking ? '检查中…' : '检查更新'}
          </button>
        </div>

        {info && !downloading && !downloaded && (
          <div className="mt-5 space-y-2 text-[13px]">
            <div className="flex justify-between border-b border-slate-800/60 py-1.5">
              <span className="text-slate-500">当前版本</span>
              <span className="font-mono text-slate-200">{info.current}</span>
            </div>
            <div className="flex justify-between border-b border-slate-800/60 py-1.5">
              <span className="text-slate-500">最新版本</span>
              <span className="font-mono text-slate-200">{info.latest ?? '未知'}</span>
            </div>
            {info.available && !info.downloaded && info.url && (
              <button
                onClick={() => void window.dshDesktop.app.openExternal(info.url as string)}
                className="mt-2 rounded-lg bg-slate-800 px-3 py-1.5 text-[13px] text-amber-300 hover:bg-slate-700"
              >
                前往下载页 ↗
              </button>
            )}
            {info.downloaded && !downloaded && (
              <button
                onClick={install}
                className="mt-2 rounded-lg bg-amber-400 px-3 py-1.5 text-[13px] font-medium text-slate-950 hover:bg-amber-300"
              >
                立即重启安装
              </button>
            )}
            {info.error && <div className="text-[12px] text-amber-400">检查失败：{info.error}</div>}
          </div>
        )}

        {/* 下载进度 */}
        {downloading && (
          <div className="mt-5">
            <div className="mb-1 flex justify-between text-[12px] text-slate-400">
              <span>正在下载更新…</span>
              <span className="font-mono">
                {downloading.percent.toFixed(1)}% · {fmtMB(downloading.transferred)} / {fmtMB(downloading.total)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-300 to-amber-500 transition-all"
                style={{ width: `${Math.min(100, downloading.percent)}%` }}
              />
            </div>
          </div>
        )}

        {/* 下载完成 */}
        {downloaded && (
          <div className="mt-5">
            <div className="mb-2 text-[13px] text-emerald-300">✓ 更新已下载完成</div>
            <button
              onClick={install}
              className="rounded-lg bg-amber-400 px-4 py-1.5 text-[13px] font-medium text-slate-950 hover:bg-amber-300"
            >
              立即重启安装
            </button>
          </div>
        )}
      </section>
    </div>
  )
}