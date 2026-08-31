/**
 * TipDialog —— 打赏弹层
 * 侧栏「支持作者」入口点击后展示打赏图（resources/tip.png，随 renderer 打包）。
 * 图片缺失时回退为心形占位，保证功能可用。
 */
import { useEffect, useState } from 'react'
import tipImage from '../../../resources/tip.png'
import { IconHeart, IconX } from './ui/icons'

interface Props {
  open: boolean
  onClose: () => void
}

export function TipDialog({ open, onClose }: Props): React.JSX.Element | null {
  const [imgFailed, setImgFailed] = useState(false)

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 重新打开时重置图片失败态
  useEffect(() => {
    if (open) setImgFailed(false)
  }, [open])

  if (!open) return null

  return (
    <div
      className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="打赏支持"
        className="modal-in w-full max-w-xs rounded-card border border-rule bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">支持一下作者</h2>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="rounded-control p-1 text-ink-3 transition-colors duration-150 hover:bg-white/5 hover:text-ink"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="mt-4 flex justify-center">
          {imgFailed ? (
            <div className="flex h-60 w-60 flex-col items-center justify-center gap-2 rounded-card border border-dashed border-rule bg-canvas/50 text-ink-3">
              <IconHeart size={28} />
              <span className="text-xs">打赏图缺失</span>
            </div>
          ) : (
            <img
              src={tipImage}
              alt="打赏码"
              className="h-60 w-60 rounded-control border border-rule object-contain"
              draggable={false}
              onError={() => setImgFailed(true)}
            />
          )}
        </div>

        <p className="mt-4 text-center text-xs leading-relaxed text-ink-3">
          如果 DSH-Exoskeleton 帮到了你，欢迎扫码打赏支持 💛
        </p>
      </div>
    </div>
  )
}
