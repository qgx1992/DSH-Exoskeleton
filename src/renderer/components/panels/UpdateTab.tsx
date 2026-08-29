import { useEffect, useState } from 'react'
import type { UpdateInfo } from '../../../shared/types'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

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
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <h2 className="text-lg font-semibold text-ink">自动更新</h2>
        <p className="mt-1 text-xs text-ink-3">
          NSIS 安装版：后台静默检查并下载，就绪后提示一键重启安装；便携版/开发版提供下载页引导。
        </p>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" loading={checking} disabled={checking} onClick={() => void check()}>
            {checking ? '检查中…' : '检查更新'}
          </Button>
        </div>

        {info && !downloading && !downloaded && (
          <div className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between border-b border-rule/60 py-1.5">
              <span className="text-xs text-ink-3">当前版本</span>
              <span className="font-mono text-xs text-ink">{info.current}</span>
            </div>
            <div className="flex justify-between border-b border-rule/60 py-1.5">
              <span className="text-xs text-ink-3">最新版本</span>
              <span className="font-mono text-xs text-ink">{info.latest ?? '未知'}</span>
            </div>
            {info.available && !info.downloaded && info.url && (
              <Button
                variant="secondary"
                className="mt-2"
                onClick={() => void window.dshDesktop.app.openExternal(info.url as string)}
              >
                前往下载页 ↗
              </Button>
            )}
            {info.downloaded && !downloaded && (
              <Button variant="primary" className="mt-2" onClick={install}>
                立即重启安装
              </Button>
            )}
            {info.error && <div className="pt-1 text-xs text-warning">检查失败：{info.error}</div>}
          </div>
        )}

        {/* 下载进度 */}
        {downloading && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-ink-2">
              <span>正在下载更新…</span>
              <span className="font-mono">
                {downloading.percent.toFixed(1)}% · {fmtMB(downloading.transferred)} / {fmtMB(downloading.total)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="progress-fill rounded-full bg-accent"
                style={{ transform: `scaleX(${Math.min(100, downloading.percent) / 100})` }}
              />
            </div>
          </div>
        )}

        {/* 下载完成 */}
        {downloaded && (
          <div className="mt-4">
            <div className="mb-2 text-sm text-success">✓ 更新已下载完成</div>
            <Button variant="primary" onClick={install}>
              立即重启安装
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
