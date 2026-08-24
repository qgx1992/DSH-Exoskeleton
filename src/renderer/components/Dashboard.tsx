import { useState } from 'react'
import type { DSHState } from '../../shared/types'
import { StatusTab } from './panels/StatusTab'
import { SettingsTab } from './panels/SettingsTab'
import { LogsTab } from './panels/LogsTab'
import { UpdateTab } from './panels/UpdateTab'
import { BackupTab } from './panels/BackupTab'
import { PluginsTab } from './panels/PluginsTab'
import { KernelsTab } from './panels/KernelsTab'

type Tab = 'status' | 'settings' | 'kernels' | 'plugins' | 'backup' | 'logs' | 'update'

interface Props {
  state: DSHState | null
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'status', label: '状态', icon: '◈' },
  { id: 'settings', label: '设置', icon: '⚙' },
  { id: 'kernels', label: '内核', icon: '⬡' },
  { id: 'plugins', label: '插件', icon: '◆' },
  { id: 'backup', label: '备份', icon: '▣' },
  { id: 'logs', label: '日志', icon: '☰' },
  { id: 'update', label: '更新', icon: '↻' }
]

export function Dashboard({ state, onStart, onStop, onRestart }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('status')

  return (
    <div className="flex h-full bg-[#0b0f17]">
      {/* 左侧导航 */}
      <nav className="flex w-40 shrink-0 flex-col gap-1 border-r border-slate-800/80 bg-[#0d111a] p-2">
        <div className="px-2 pb-2 pt-1 text-[11px] font-medium uppercase tracking-wider text-slate-500">
          DSH-Exoskeleton
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
              tab === t.id
                ? 'bg-cyan-500/10 text-cyan-300'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <span className="w-4 text-center text-[11px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <div className="px-2 pb-1 text-[10px] leading-relaxed text-slate-600">
          服务运行后主区域将显示 DSH Web UI
        </div>
      </nav>

      {/* 内容区 */}
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {tab === 'status' && <StatusTab state={state} onStart={onStart} onStop={onStop} onRestart={onRestart} />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'kernels' && <KernelsTab />}
        {tab === 'plugins' && <PluginsTab />}
        {tab === 'backup' && <BackupTab />}
        {tab === 'logs' && <LogsTab />}
        {tab === 'update' && <UpdateTab />}
      </main>
    </div>
  )
}