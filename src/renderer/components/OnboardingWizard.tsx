import { useState } from 'react'
import type { SetupStatus } from '../../shared/types'
import { WhaleIcon } from './WhaleIcon'
import { Button } from './ui/Button'
import { Input } from './ui/Field'

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
      <div className="w-[480px] rounded-2xl border border-rule bg-surface p-8 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-black/60 ring-1 ring-accent/30">
            <WhaleIcon size={28} />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-ink">欢迎使用 DSH-Exoskeleton</h1>
            <p className="text-xs text-ink-3">首次启动 · 完成基本配置</p>
          </div>
        </div>

        <p className="mt-5 text-sm leading-relaxed text-ink-2">
          未检测到已配置的 DeepSeek API Key。填入你的 API Key 后将写入本地凭据文件
          <code className="mx-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-accent">{status.file}</code>
          仅供本地使用，不会联网上传。
        </p>

        <div className="mt-5">
          <Input
            label="DeepSeek API Key"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && apiKey.trim()) void save()
            }}
            placeholder="sk-..."
            autoFocus
            error={error ?? undefined}
          />
          <button
            onClick={() => setShowKey((v) => !v)}
            className="mt-1.5 text-xs text-ink-3 underline-offset-2 transition-colors hover:text-ink-2 hover:underline"
          >
            {showKey ? '隐藏' : '显示'} API Key
          </button>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            onClick={() => void skip()}
            className="text-xs text-ink-3 underline-offset-2 transition-colors hover:text-ink-2 hover:underline"
          >
            跳过，稍后配置
          </button>
          <Button variant="primary" loading={saving} disabled={!apiKey.trim()} onClick={() => void save()}>
            {saving ? '保存中…' : '保存并开始'}
          </Button>
        </div>
      </div>
    </div>
  )
}
