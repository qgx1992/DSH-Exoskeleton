import { useState } from 'react'
import type { SetupStatus } from '../../shared/types'
import { WhaleIcon } from './WhaleIcon'

interface Props {
  status: SetupStatus
  onDone: () => void
}

export function OnboardingWizard({ status, onDone }: Props): React.JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const r = await window.dshDesktop.setup.save(apiKey)
      if (!r.ok) {
        setError(r.error ?? '保存失败')
        return
      }
      onDone()
    } finally {
      setSaving(false)
    }
  }

  const skip = async (): Promise<void> => {
    // 跳过引导：标记完成，稍后可在设置中配置
    await window.dshDesktop.config.set({ onboardingDone: true })
    onDone()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[480px] rounded-2xl border border-slate-700 bg-[#0d111a] p-8 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-black/60 ring-1 ring-amber-400/30">
            <WhaleIcon size={28} />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-slate-100">欢迎使用 DeepSeek Harness</h1>
            <p className="text-[12px] text-slate-500">首次启动 · 完成基本配置</p>
          </div>
        </div>

        <p className="mt-5 text-[13px] leading-relaxed text-slate-400">
          未检测到已配置的 DeepSeek API Key。填入你的 API Key 后将写入本地凭据文件
          <code className="mx-1 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-cyan-300">
            {status.file}
          </code>
          仅供本地使用，不会联网上传。
        </p>

        <div className="mt-5">
          <label className="text-[12px] font-medium text-slate-300">DeepSeek API Key</label>
          <div className="mt-1.5 flex gap-2">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && apiKey.trim()) void save()
              }}
              placeholder="sk-..."
              autoFocus
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-[13px] text-slate-100 outline-none focus:border-cyan-500"
            />
            <button
              onClick={() => setShowKey((v) => !v)}
              className="rounded-lg bg-slate-800 px-2.5 text-[12px] text-slate-400 hover:bg-slate-700"
            >
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          {error && <div className="mt-2 text-[12px] text-red-400">{error}</div>}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            onClick={() => void skip()}
            className="text-[12px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
          >
            跳过，稍后配置
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || !apiKey.trim()}
            className="rounded-lg bg-cyan-500 px-5 py-2 text-[13px] font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存并开始'}
          </button>
        </div>
      </div>
    </div>
  )
}