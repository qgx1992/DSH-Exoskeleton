import { useEffect, useState } from 'react'
import type { AppConfig, SetupStatus } from '../../../shared/types'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Toggle } from '../ui/Toggle'
import { Input, Select } from '../ui/Field'
import { Card, Notice } from '../ui/Card'

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
    return <div className="text-sm text-ink-3">加载配置中…</div>
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">基础设置</h2>
          {saved && <span className="text-xs text-success">✓ 已保存</span>}
        </div>

        <div className="mt-4 space-y-4 text-sm">
          {/* 端口 */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-ink">Web 服务端口</div>
              <div className="mt-0.5 text-xs text-ink-3">0 = 自动选择空闲端口（推荐）。修改后需重启服务生效。</div>
            </div>
            <Input
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
              className="w-28 text-right"
            />
          </div>

          {/* DSH Home */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-ink">DSH Home 目录</div>
              <div className="mt-0.5 text-xs text-ink-3">留空则遵循官方规则（DSH_HOME 或 ~/.dsh）</div>
            </div>
            <Input
              type="text"
              value={dshHomeInput}
              onChange={(e) => setDshHomeInput(e.target.value)}
              onBlur={() => {
                if (dshHomeInput !== cfg.dshHome) void save({ dshHome: dshHomeInput.trim() })
              }}
              placeholder="例如 C:\Users\you\.dsh"
              className="w-72 text-xs"
            />
          </div>

          {/* 开关项 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink">开机自启</div>
              <div className="mt-0.5 text-xs text-ink-3">登录 Windows 后后台静默启动</div>
            </div>
            <Toggle checked={cfg.autoLaunch} onChange={(v) => void save({ autoLaunch: v })} aria-label="开机自启" />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink">启动时自动运行 DSH 服务</div>
              <div className="mt-0.5 text-xs text-ink-3">应用启动后自动拉起 dsh web</div>
            </div>
            <Toggle
              checked={cfg.autoStartService}
              onChange={(v) => void save({ autoStartService: v })}
              aria-label="启动时自动运行 DSH 服务"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink">服务状态原生通知</div>
              <div className="mt-0.5 text-xs text-ink-3">服务就绪 / 异常时发送 Windows 通知</div>
            </div>
            <Toggle
              checked={cfg.notifyServiceEvents}
              onChange={(v) => void save({ notifyServiceEvents: v })}
              aria-label="服务状态原生通知"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink">会话完成通知</div>
              <div className="mt-0.5 text-xs text-ink-3">Agent 会话结束后发送 Windows 通知</div>
            </div>
            <Toggle
              checked={cfg.notifySessionDone !== 'off'}
              onChange={(v) => void save({ notifySessionDone: v ? 'per-turn' : 'off' })}
              aria-label="会话完成通知"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink">通知渠道</div>
              <div className="mt-0.5 text-xs text-ink-3">auto = Web UI 可见时页面内提示，失焦/隐藏走系统通知</div>
            </div>
            <Select
              value={cfg.notifyChannel}
              onChange={(e) => void save({ notifyChannel: e.target.value as AppConfig['notifyChannel'] })}
              className="w-40"
            >
              <option value="auto">自动（推荐）</option>
              <option value="native">系统通知</option>
              <option value="webview">Web UI 内提示</option>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink">通知聚合窗口（毫秒）</div>
              <div className="mt-0.5 text-xs text-ink-3">「聚合」模式下同一会话多轮合并为一条；默认 5000</div>
            </div>
            <Input
              type="number"
              min={500}
              max={60000}
              value={aggInput}
              onChange={(e) => setAggInput(e.target.value)}
              onBlur={() => void saveAggWindow()}
              className="w-28 text-right"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink">测试通知</div>
              <div className="mt-0.5 text-xs text-ink-3">发送一条系统通知验证设置是否生效</div>
            </div>
            <div className="flex items-center gap-2">
              {notifyMsg && (
                <span className={`text-2xs ${notifyMsg.type === 'ok' ? 'text-success' : 'text-danger'}`}>{notifyMsg.text}</span>
              )}
              <Button variant="secondary" size="sm" onClick={() => void testNotify()}>
                发送测试通知
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-ink">关闭窗口时隐藏到托盘</div>
              <div className="mt-0.5 text-xs text-ink-3">而非退出进程</div>
            </div>
            <Toggle checked={cfg.minimizeToTray} onChange={(v) => void save({ minimizeToTray: v })} aria-label="关闭窗口时隐藏到托盘" />
          </div>
        </div>
      </Card>

      {/* API Key 管理（P1） */}
      <Card>
        <h3 className="text-xs font-semibold tracking-wider text-ink-2">API Key</h3>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          DeepSeek API Key 仅保存在本地凭据文件（
          <code className="rounded bg-surface-2 px-1 py-px font-mono text-2xs text-accent">~/.dsh/.credentials.yaml</code>
          ），不联网上传。
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {setupStatus?.configured ? (
            <Badge tone="green">✓ 已配置</Badge>
          ) : (
            <Badge tone="gray">{setupStatus ? '未配置' : '检测中…'}</Badge>
          )}
          {setupStatus?.malformed && <Badge tone="red">凭据文件解析异常</Badge>}
          {setupStatus && setupStatus.refs.length > 0 && (
            <span className="text-2xs text-ink-3">已检测变量：{setupStatus.refs.join('、')}</span>
          )}
        </div>

        <div className="mt-3 flex items-start gap-2">
          <Input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey()
            }}
            placeholder="输入新的 API Key（sk-...）"
            className="flex-1"
          />
          <Button variant="primary" loading={keyBusy} disabled={!keyInput.trim() || keyBusy} onClick={() => void saveKey()}>
            {keyBusy ? '保存中…' : '保存'}
          </Button>
          {setupStatus?.configured && (
            <Button variant="danger" disabled={keyBusy} onClick={() => void clearKey()}>
              清除
            </Button>
          )}
        </div>

        {keyMsg && (
          <div className="mt-3">
            <Notice tone={keyMsg.type}>{keyMsg.text}</Notice>
          </div>
        )}

        {setupStatus && (
          <div className="mt-2 text-2xs text-ink-3 selectable">
            凭据文件：<code className="font-mono">{setupStatus.file}</code>
          </div>
        )}
      </Card>
    </div>
  )
}
