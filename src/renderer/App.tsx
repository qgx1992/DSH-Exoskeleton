import { useCallback, useEffect, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { Dashboard } from './components/Dashboard'
import { OnboardingWizard } from './components/OnboardingWizard'
import type { DSHState, SetupStatus } from '../shared/types'

const api = window.dshDesktop

export default function App(): React.JSX.Element {
  const [dshState, setDshState] = useState<DSHState | null>(null)
  const [maximized, setMaximized] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  /** 管理面板（Dashboard）是否打开：打开时主进程隐藏 DSH Web UI 视图 */
  const [adminPanel, setAdminPanel] = useState(false)

  useEffect(() => {
    void api.app.getVersion().then(setAppVersion)
    void api.dsh.getState().then(setDshState)
    // 首次启动引导检测
    void (async () => {
      const [cfg, setup] = await Promise.all([api.config.get(), api.setup.check()])
      setSetupStatus(setup)
      if (!cfg.onboardingDone && !setup.configured) {
        setShowOnboarding(true)
      }
    })()
    // R-29: 移除 400ms 延迟二次 getState（与 onStateChange 推送构成双数据源，可能旧盖新）；
    //       状态更新由主进程推送驱动，挂载时已有一次 getState 兜底
    const offStatus = api.dsh.onStateChange(setDshState)
    const offMax = api.window.onMaximizeChange(setMaximized)
    void api.window.isMaximized().then(setMaximized)
    return () => {
      offStatus()
      offMax()
    }
  }, [])

  const handleOnboardingDone = useCallback(() => {
    setShowOnboarding(false)
    void api.config.set({ onboardingDone: true })
  }, [])

  const handleStart = useCallback(async () => {
    await api.dsh.start()
  }, [])
  const handleStop = useCallback(async () => {
    await api.dsh.stop()
  }, [])
  const handleRestart = useCallback(async () => {
    await api.dsh.restart()
  }, [])

  /** 回到 DSH Web UI：关闭管理面板（主进程同步恢复 WebContentsView 可见） */
  const handleOpenWebUI = useCallback(() => {
    setAdminPanel(false)
  }, [])

  // 管理面板显隐与主进程同步（隐藏 DSH Web UI 视图）
  useEffect(() => {
    void api.window.setAdminPanelVisible(adminPanel)
  }, [adminPanel])

  const running = dshState?.status === 'running'

  return (
    <div className="flex h-screen flex-col bg-[#0b0f17]">
      <TitleBar
        status={dshState?.status ?? 'starting'}
        port={dshState?.port ?? null}
        version={dshState?.version ?? null}
        appVersion={appVersion}
        maximized={maximized}
        adminPanel={adminPanel}
        onToggleAdminPanel={() => setAdminPanel((v) => !v)}
      />
      {/* 服务运行中时，此区域被主进程挂载的 WebContentsView（DSH Web UI）覆盖；
          管理面板打开时主进程会隐藏该视图，露出 Dashboard */}
      <div className="min-h-0 flex-1">
        {!running || adminPanel ? (
          <Dashboard
            state={dshState}
            onStart={handleStart}
            onStop={handleStop}
            onRestart={handleRestart}
            onOpenWebUI={handleOpenWebUI}
          />
        ) : (
          <div className="h-full w-full bg-[#0b0f17]" />
        )}
      </div>

      {showOnboarding && setupStatus && (
        <OnboardingWizard status={setupStatus} onDone={handleOnboardingDone} />
      )}
    </div>
  )
}