import { useCallback, useEffect, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { OnboardingWizard } from './components/OnboardingWizard'
import { ConfirmProvider } from './components/ui/Confirm'
import type { DSHState, SetupStatus, DashboardTab } from '../shared/types'

const api = window.dshDesktop

export default function App(): React.JSX.Element {
  const [dshState, setDshState] = useState<DSHState | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  /** 管理面板（Dashboard）是否打开：打开时主进程隐藏 DSH Web UI 视图。
   *  入口：托盘菜单「管理面板…」；面板内可「回到 Web UI」关闭。 */
  const [adminPanel, setAdminPanel] = useState(false)
  /** 管理面板当前激活标签 */
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('overview')

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
    // 托盘菜单 → 打开管理面板并定位标签
    const offOpenPanel = api.window.onOpenPanel((tab) => {
      setAdminPanel(true)
      setDashboardTab(tab)
    })
    return () => {
      offStatus()
      offOpenPanel()
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
    // ConfirmProvider 包在最外层：各面板用 useConfirm() 弹应用内确认，不再用 window.confirm
    <ConfirmProvider>
      <div className="flex h-screen flex-col bg-canvas">
        {/* 无系统标题栏：内容从 y=0 起，右上角由系统原生窗口按钮叠加（titleBarOverlay）。
            服务运行中时此区域被主进程挂载的 WebContentsView（DSH Web UI）覆盖，
            顶部那条即 DSH 自己的侧边栏品牌行；管理面板打开时主进程隐藏该视图。 */}
        <div className="min-h-0 flex-1">
          {!running || adminPanel ? (
            <Dashboard
              state={dshState}
              appVersion={appVersion}
              activeTab={dashboardTab}
              onTabChange={setDashboardTab}
              onStart={handleStart}
              onStop={handleStop}
              onRestart={handleRestart}
              onOpenWebUI={handleOpenWebUI}
            />
          ) : (
            <div className="h-full w-full bg-canvas" />
          )}
        </div>

        {showOnboarding && setupStatus && (
          <OnboardingWizard status={setupStatus} onDone={handleOnboardingDone} />
        )}
      </div>
    </ConfirmProvider>
  )
}
