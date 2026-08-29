import { useEffect, useState } from 'react'
import type { AppConfig, SetupStatus } from '../../../shared/types'

export function SettingsTab(): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [portInput, setPortInput] = useState('')
  const [dshHomeInput, setDshHomeInput] = useState('')
  const [aggInput, setAggInput] = useState('')
  const [notifyMsg, setNotifyMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  // API Key 管理
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    void window.dshDesktop.config.get().then((c) => {
      setCfg(c)
      setPortInput(String(c.port))
      setDshHomeInput(c.dshHome)
      setAggInput(String(c.notifyAggregateWindowMs ?? 5000))
    })
    void window.dshDesktop.setup.check().then(setSetupStatus)
  }, [])

  const save = async (patch: Partial<AppConfig>): Promise<void> => {
    const next = await window.dshDesktop.config.set(patch)
    setCfg(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const refreshSetup = async (): Promise<void> => {
    setSetupStatus(await window.dshDesktop.setup.check())
  }

  const saveKey = async (): Promise<void> => {
    setKeyBusy(true)
    setKeyMsg(null)
    const r = await window.dshDesktop.setup.save(keyInput.trim())
    setKeyBusy(false)
    setKeyMsg(r.ok ? { type: 'ok', text: '✓ API Key 已保存到本地凭据文件' } : { type: 'err', text: r.error ?? '保存失败' })
    if (r.ok) {
      setKeyInput('')
      await refreshSetup()
    }
  }

  const clearKey = async (): Promise<void> => {
    if (!window.confirm('清除已保存的 API Key？')) return
    setKeyBusy(true)
    setKeyMsg(null)
    const r = await window.dshDesktop.setup.clear()
    setKeyBusy(false)
    setKeyMsg(r.ok ? { type: 'ok', text: 'API Key 已清除' } : { type: 'err', text: r.error ?? '清除失败' })
    await refreshSetup()
  }

  const saveAggWindow = async (): Promise<void> => {
    const n = parseInt(aggInput, 10)
    if (Number.isNaN(n) || n < 500) {
      setAggInput(String(cfg?.notifyAggregateWindowMs ?? 5000))
      return
    }
    if (n !== cfg?.notifyAggregateWindowMs) {
      await save({ notifyAggregateWindowMs: Math.min(60000, n) })
      setAggInput(String(Math.min(60000, n)))
    }
  }

  const testNotify = async (): Promise<void> => {
    setNotifyMsg(null)
    const r = await window.dshDesktop.notify.test()
    setNotifyMsg(r.ok ? { type: 'ok', text: '✓ 测试通知已发送（系统通知）' } : { type: 'err', text: '发送失败（系统可能不支持通知）' })
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
            <Toggle
              checked={cfg.notifySessionDone !== 'off'}
              onChange={(v) => void save({ notifySessionDone: v ? 'per-turn' : 'off' })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-200">通知渠道</div>
              <div className="mt-0.5 text-[12px] text-slate-500">auto = Web UI 可见时页面内提示，失焦/隐藏走系统通知</div>
            </div>
            <select
              value={cfg.notifyChannel}
              onChange={(e) => void save({ notifyChannel: e.target.value as AppConfig['notifyChannel'] })}
              className="w-40 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-[12px] text-slate-100 outline-none focus:border-cyan-500"
            >
              <option value="auto">自动（推荐）</option>
              <option value="native">系统通知</option>
              <option value="webview">Web UI 内提示</option>
            </select>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-200">通知聚合窗口（毫秒）</div>
              <div className="mt-0.5 text-[12px] text-slate-500">「聚合」模式下同一会话多轮合并为一条；默认 5000</div>
            </div>
            <input
              type="number"
              min={500}
              max={60000}
              value={aggInput}
              onChange={(e) => setAggInput(e.target.value)}
              onBlur={() => void saveAggWindow()}
              className="w-28 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-right font-mono text-slate-100 outline-none focus:border-cyan-500"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-slate-200">测试通知</div>
              <div className="mt-0.5 text-[12px] text-slate-500">发送一条系统通知验证设置是否生效</div>
            </div>
            <div className="flex items-center gap-2">
              {notifyMsg && (
                <span className={`text-[11px] ${notifyMsg.type === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {notifyMsg.text}
                </span>
              )}
              <button
                onClick={() => void testNotify()}
                className="rounded-md bg-cyan-500/20 px-3 py-1.5 text-[12px] text-cyan-300 hover:bg-cyan-500/30"
              >
                发送测试通知
              </button>
            </div>
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

      {/* API Key 管理（P1） */}
      <section className="rounded-xl border border-slate-800/70 bg-[#0d111a] p-6">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">API Key</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-400">
          DeepSeek API Key 仅保存在本地凭据文件（<code className="rounded bg-slate-800 px-1 py-px font-mono text-[11px] text-amber-300">~/.dsh/.credentials.yaml</code>），不联网上传。
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              setupStatus?.configured
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-slate-700 bg-slate-800 text-slate-400'
            }`}
          >
            {setupStatus ? (setupStatus.configured ? '✓ 已配置' : '未配置') : '检测中…'}
          </span>
          {setupStatus?.malformed && (
            <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300">凭据文件解析异常</span>
          )}
          {setupStatus && setupStatus.refs.length > 0 && (
            <span className="text-[11px] text-slate-500">已检测变量：{setupStatus.refs.join('、')}</span>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey()
            }}
            placeholder="输入新的 API Key（sk-...）"
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-[13px] text-slate-100 outline-none focus:border-cyan-500"
          />
          <button
            onClick={() => void saveKey()}
            disabled={!keyInput.trim() || keyBusy}
            className="shrink-0 rounded-lg bg-cyan-500 px-4 py-1.5 text-[13px] font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {keyBusy ? '保存中…' : '保存'}
          </button>
          {setupStatus?.configured && (
            <button
              onClick={() => void clearKey()}
              disabled={keyBusy}
              className="shrink-0 rounded-lg bg-slate-800 px-4 py-1.5 text-[13px] text-slate-400 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50"
            >
              清除
            </button>
          )}
        </div>

        {keyMsg && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-[12px] ${
              keyMsg.type === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {keyMsg.text}
          </div>
        )}

        {setupStatus && (
          <div className="mt-2 text-[11px] text-slate-600">
            凭据文件：<code className="font-mono">{setupStatus.file}</code>
          </div>
        )}
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
