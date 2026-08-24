import { useEffect, useState } from 'react'
import type { AppConfig } from '../../../shared/types'

export function SettingsTab(): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [portInput, setPortInput] = useState('')
  const [dshHomeInput, setDshHomeInput] = useState('')

  useEffect(() => {
    void window.dshDesktop.config.get().then((c) => {
      setCfg(c)
      setPortInput(String(c.port))
      setDshHomeInput(c.dshHome)
    })
  }, [])

  const save = async (patch: Partial<AppConfig>): Promise<void> => {
    const next = await window.dshDesktop.config.set(patch)
    setCfg(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  if (!cfg) {
    return <div className="text-slate-500">加载配置中…</div>
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="rounded-xl border border-slate-800 bg-[#0d111a] p-6">
        <h2 className="text-lg font-semibold text-slate-100">基础设置</h2>

        <div className="mt-4 space-y-4 text-[13px]">
          {/* 端口 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-200">Web 服务端口</div>
              <div className="mt-0.5 text-[12px] text-slate-500">0 = 自动选择空闲端口（推荐）。修改后需重启服务生效。</div>
            </div>
            <input
              type="number"
              min={0}
              max={65535}
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              onBlur={() => {
                const n = parseInt(portInput || '0', 10)
                if (!Number.isNaN(n) && n >= 0 && n <= 65535 && n !== cfg.port) {
                  void save({ port: n })
                } else {
                  setPortInput(String(cfg.port))
                }
              }}
              className="w-28 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-right font-mono text-slate-100 outline-none focus:border-cyan-500"
            />
          </div>

          {/* DSH Home */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-slate-200">DSH Home 目录</div>
              <div className="mt-0.5 text-[12px] text-slate-500">留空则遵循官方规则（DSH_HOME 或 ~/.dsh）</div>
            </div>
            <input
              type="text"
              value={dshHomeInput}
              onChange={(e) => setDshHomeInput(e.target.value)}
              onBlur={() => {
                if (dshHomeInput !== cfg.dshHome) void save({ dshHome: dshHomeInput.trim() })
              }}
              placeholder="例如 C:\Users\you\.dsh"
              className="w-72 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-[12px] text-slate-100 outline-none focus:border-cyan-500"
            />
          </div>

          {/* 开关项 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-200">开机自启</div>
              <div className="mt-0.5 text-[12px] text-slate-500">登录 Windows 后后台静默启动</div>
            </div>
            <Toggle checked={cfg.autoLaunch} onChange={(v) => void save({ autoLaunch: v })} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-200">启动时自动运行 DSH 服务</div>
              <div className="mt-0.5 text-[12px] text-slate-500">应用启动后自动拉起 dsh web</div>
            </div>
            <Toggle checked={cfg.autoStartService} onChange={(v) => void save({ autoStartService: v })} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-200">服务状态原生通知</div>
              <div className="mt-0.5 text-[12px] text-slate-500">服务就绪 / 异常时发送 Windows 通知</div>
            </div>
            <Toggle checked={cfg.notifyServiceEvents} onChange={(v) => void save({ notifyServiceEvents: v })} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-200">会话完成通知</div>
              <div className="mt-0.5 text-[12px] text-slate-500">Agent 会话结束后发送 Windows 通知</div>
            </div>
            <Toggle checked={cfg.notifySessionDone} onChange={(v) => void save({ notifySessionDone: v })} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-200">关闭窗口时隐藏到托盘</div>
              <div className="mt-0.5 text-[12px] text-slate-500">而非退出进程</div>
            </div>
            <Toggle checked={cfg.minimizeToTray} onChange={(v) => void save({ minimizeToTray: v })} />
          </div>
        </div>

        {saved && <div className="mt-4 text-[12px] text-emerald-400">✓ 已保存</div>}
      </section>

      {/* API Key 说明（P1 首次启动引导） */}
      <section className="rounded-xl border border-slate-800/70 bg-[#0d111a] p-6">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">API Key（开发中）</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-400">
          DeepSeek API Key 配置与首次启动引导向导将在 P1 阶段提供。Key 仅保存在本地（系统级加密），
          不联网上传。当前阶段可在 ~/.dsh 中按官方方式配置。
        </p>
      </section>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-cyan-500' : 'bg-slate-700'}`}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  )
}