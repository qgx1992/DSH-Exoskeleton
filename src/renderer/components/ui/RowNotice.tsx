/**
 * RowNotice —— 行内结果提示（跟随触发它的那一行渲染）
 * 列表行的操作（检测 / 设为默认 / 升级 / 安装 / 卸载）结果就地反馈，
 * 避免顶/底全局横幅在长列表里离触发控件太远、看不到；
 * 仅"整卡级"操作（检查全部更新、一键安装全部、模式切换）保留 Notice 横幅。
 */
import type { ReactNode } from 'react'

/** 行内/横幅结果提示的统一形状 */
export interface RowMessage {
  type: 'ok' | 'err'
  text: string
}

export function RowNotice({ msg }: { msg: RowMessage | null | undefined }): ReactNode {
  if (!msg) return null
  return (
    <div className={`mt-1 px-3 text-2xs leading-relaxed ${msg.type === 'ok' ? 'text-success' : 'text-danger'}`} role="status">
      {msg.text}
    </div>
  )
}
