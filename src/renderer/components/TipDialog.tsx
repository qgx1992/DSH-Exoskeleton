/**
 * TipDialog —— 打赏弹层（侧栏「支持作者」入口）
 * 展示 resources/tip.png（随 renderer 打包）；图片缺失时回退心形占位，保证功能可用。
 * 遮罩/焦点/Esc 一律走 Modal 原语，不在页面里自绘弹层。
 */
import { useEffect, useState } from 'react'
import tipImage from '../../../resources/tip.png'
import { Modal } from './ui/Modal'
import { IconHeart } from './ui/icons'

interface Props {
  open: boolean
  onClose: () => void
}

export function TipDialog({ open, onClose }: Props): React.JSX.Element {
  const [imgFailed, setImgFailed] = useState(false)

  // 重新打开时重置图片失败态
  useEffect(() => {
    if (open) setImgFailed(false)
  }, [open])

  return (
    <Modal open={open} onClose={onClose} title="支持一下作者" className="max-w-xs">
      <div className="mt-1 flex justify-center">
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
    </Modal>
  )
}
