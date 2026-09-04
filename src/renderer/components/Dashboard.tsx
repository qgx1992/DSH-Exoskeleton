import { useState, type ReactNode } from 'react'
import type { DSHState } from '../../shared/types'
import { OverviewTab } from './panels/OverviewTab'
import { StatusTab } from './panels/StatusTab'
import { SettingsTab } from './panels/SettingsTab'
import { LogsTab } from './panels/LogsTab'
import { UpdateTab } from './panels/UpdateTab'
import { BackupTab } from './panels/BackupTab'
import { PluginsTab } from './panels/PluginsTab'
import { KernelsTab } from './panels/KernelsTab'
import { ProfilesTab } from './panels/ProfilesTab'
import { SessionsTab } from './panels/SessionsTab'
import { TipDialog } from './TipDialog'
import {
  IconActivity,
  IconShield,
  IconLayers,
  IconList,
  IconMessage,
  IconOverview,
  IconZap,
  IconRefresh,
  IconSettings,
  IconBox,
  IconHeart,
  IconGlobe
} from './ui/icons'

/** 导航标签（左侧导航可切换的普通面板） */
type Tab = 'overview' | 'status' | 'sessions' | 'settings' | 'kernels' | 'profiles' | 'plugins' | 'backup' | 'logs' | 'update'
/** 附加视图：网页版 DeepSeek（入口在标题栏右上角按钮，不属于左侧导航） */
type PanelView = Tab | 'web'

interface Props {
  state: DSHState | null
  /** 当前激活视图（受控；'web' = 网页版 DeepSeek，由 App 标题栏按钮驱动） */
  activeTab: PanelView
  /** 视图切换回调 */
  onTabChange: (tab: PanelView) => void
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  /** 关闭管理面板，回到 DSH Web UI */
  onOpenWebUI: () => void
}

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: '总览', icon: <IconOverview size={15} /> },
  { id: 'status', label: '状态', icon: <IconActivity size={15} /> },
  { id: 'sessions', label: '会话', icon: <IconMessage size={15} /> },
  { id: 'settings', label: '设置', icon: <IconSettings size={15} /> },
  { id: 'kernels', label: '内核', icon: <IconBox size={15} /> },
  { id: 'profiles', label: '档案', icon: <IconLayers size={15} /> },
  { id: 'plugins', label: '插件', icon: <IconZap size={15} /> },
  { id: 'backup', label: '备份', icon: <IconShield size={15} /> },
  { id: 'logs', label: '日志', icon: <IconList size={15} /> },
  { id: 'update', label: '更新', icon: <IconRefresh size={15} /> }
]

export function Dashboard({ state, activeTab, onTabChange, onStart, onStop, onRestart, onOpenWebUI }: Props): React.JSX.Element {
  const [tipOpen, setTipOpen] = useState(false)

  return (
    <div className="flex h-full bg-canvas">
      {/* 左侧导航 */}
      <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-rule bg-surface p-2">
        <div className="px-2.5 pb-2 pt-1 text-2xs uppercase tracking-[0.14em] text-ink-3">DSH-Exoskeleton</div>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            className={'relative flex items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-sm transition-colors duration-150 ease-hallmark ' + (activeTab === t.id ? 'bg-surface-2 text-accent' : 'text-ink-2 hover:bg-white/5 hover:text-ink')}
          >
            {activeTab === t.id && <span className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-accent" />}
            <span className="flex w-4 justify-center opacity-90">{t.icon}</span>
            {t.label}
          </button>
        ))}
        {/* 打赏入口：紧跟在「更新」之后，点击弹出打赏图（非页面标签） */}
        <button
          onClick={() => setTipOpen(true)}
          title="打赏支持"
          className="relative flex items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-sm text-ink-3 transition-colors duration-150 ease-hallmark hover:bg-white/5 hover:text-accent"
        >
          <span className="flex w-4 justify-center opacity-90">
            <IconHeart size={15} />
          </span>
          支持作者
        </button>
        <div className="flex-1" />
        <div className="px-2.5 pb-1 text-2xs leading-relaxed text-ink-3">服务运行后主区域将显示 DSH Web UI</div>
      </nav>

      {/* 内容区（key 触发 180ms 入场动画） */}
      <main key={activeTab} className="panel-enter min-w-0 flex-1 overflow-y-auto p-5">
        {activeTab === 'overview' && (
          <OverviewTab state={state} onStart={onStart} onStop={onStop} onRestart={onRestart} onOpenWebUI={onOpenWebUI} />
        )}
        {activeTab === 'web' && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <IconGlobe size={30} className="text-ink-3 opacity-60" />
            <p className="mt-2 text-sm font-medium text-ink">网页版 DeepSeek</p>
            <p className="mt-0.5 max-w-md text-xs text-ink-3">
              右侧区域由独立原生视图承载（chat.deepseek.com），首次打开加载稍慢；登录态保存在本机，重启后保留。
            </p>
          </div>
        )}
        {activeTab === 'status' && <StatusTab state={state} onStart={onStart} onStop={onStop} onRestart={onRestart} />}
        {activeTab === 'sessions' && <SessionsTab onOpenWebUI={onOpenWebUI} />}
        {activeTab === 'settings' && <SettingsTab />}
        {activeTab === 'kernels' && <KernelsTab />}
        {activeTab === 'profiles' && <ProfilesTab />}
        {activeTab === 'plugins' && <PluginsTab />}
        {activeTab === 'backup' && <BackupTab />}
        {activeTab === 'logs' && <LogsTab />}
        {activeTab === 'update' && <UpdateTab />}
      </main>

      <TipDialog open={tipOpen} onClose={() => setTipOpen(false)} />
    </div>
  )
}
