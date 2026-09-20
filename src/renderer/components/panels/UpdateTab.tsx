import { useEffect, useState } from 'react'
import type { UpdateInfo } from '../../../shared/types'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Toggle } from '../ui/Toggle'

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
  /** 自动检查更新开关（config.autoCheckUpdate）；null = 配置未加载完成 */
  const [autoCheck, setAutoCheck] = useState<boolean | null>(null)
  /** 自动下载更新开关（config.autoDownloadUpdate）；null = 配置未加载完成 */
  const [autoDownload, setAutoDownload] = useState<boolean | null>(null)
  /** 手动下载进行中（点「下载更新」后等待主进程 resolve） */
  const [downloadingNow, setDownloadingNow] = useState(false)
  const [downloadError, setDownloadError] = useState('')

  useEffect(() => {
    void window.dshDesktop.config.get().then((c) => {
      setAutoCheck(c.autoCheckUpdate !== false)
      setAutoDownload(c.autoDownloadUpdate !== false)
    })
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

  const toggleAutoCheck = async (v: boolean): Promise<void> => {
    setAutoCheck(v)
    const next = await window.dshDesktop.config.set({ autoCheckUpdate: v })
    setAutoCheck(next.autoCheckUpdate !== false)
  }

  const toggleAutoDownload = async (v: boolean): Promise<void> => {
    setAutoDownload(v)
    const next = await window.dshDesktop.config.set({ autoDownloadUpdate: v })
    setAutoDownload(next.autoDownloadUpdate !== false)
  }

  const downloadNow = async (): Promise<void> => {
    setDownloadingNow(true)
    setDownloadError('')
    try {
      const r = await window.dshDesktop.updater.download()
      if (!r.ok && r.error) setDownloadError(r.error)
    } finally {
      setDownloadingNow(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <h2 className="text-lg font-semibold text-ink">自动更新</h2>
        <p className="mt-1 text-xs text-ink-3">
          NSIS 安装版：后台静默检查并下载，就绪后提示一键重启安装；便携版/开发版提供下载页引导。
        </p>

        <div className="mt-4 border-b border-rule/60 pb-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-ink">自动检查更新</div>
              <div className="mt-0.5 text-xs text-ink-3">
                启动后后台静默检查新版本；关闭后不会主动联网检查（仍可手动点「检查更新」）
              </div>
            </div>
            <Toggle
              checked={autoCheck ?? true}
              disabled={autoCheck === null}
              onChange={(v) => void toggleAutoCheck(v)}
              aria-label="自动检查更新"
            />
          </div>

          <div className="mt-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-ink">自动下载更新</div>
              <div className="mt-0.5 text-xs text-ink-3">
                发现新版本后后台静默下载，下载完成随退出自动安装；关闭后仅提示有新版本，由你决定何时下载（不影响上面的「检查」）
              </div>
            </div>
            <Toggle
              checked={autoDownload ?? true}
              disabled={autoDownload === null}
              onChange={(v) => void toggleAutoDownload(v)}
              aria-label="自动下载更新"
            />
          </div>
          {autoDownload === false && (
            <p className="mt-2 text-xs text-ink-3">
              已关闭自动下载：检查到新版本后需在本页点「下载更新」；下载完成后也不会随退出自动安装，需点「立即重启安装」。
            </p>
          )}
        </div>

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
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {/* 「下载更新」只在支持静默下载（安装版）时出现：便携版/开发版无此通道，
                    点了只会拿到错误，不如直接给下载页入口（autoUpdateSupported 由主进程告知） */}
                {info.autoUpdateSupported && (
                  <Button variant="primary" loading={downloadingNow} disabled={downloadingNow} onClick={() => void downloadNow()}>
                    {downloadingNow ? '下载中…' : '下载更新'}
                  </Button>
                )}
                <Button variant="secondary" onClick={() => void window.dshDesktop.app.openExternal(info.url as string)}>
                  前往下载页 ↗
                </Button>
              </div>
            )}
            {downloadError && <div className="pt-1 text-xs text-warning">下载失败：{downloadError}</div>}
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
