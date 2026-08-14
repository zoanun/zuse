import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from './useFocusTrap.js'

/**
 * App-styled modal confirm (replaces window.confirm). Renders nothing when closed; portaled to
 * body so it floats above the drawer. Clicking the backdrop cancels; Escape cancels too — handled
 * in the capture phase with stopPropagation so it beats (and suppresses) the drawer's own Escape
 * handler, preventing a second confirm dialog from stacking on top of this one.
 */
export function ConfirmDialog({ open, message, confirmLabel = '放弃修改', cancelLabel = '取消', onConfirm, onCancel }: {
  open: boolean
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true) // capture: run before the drawer's bubble handler
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])
  // aria-modal="true" 是对辅助技术下的承诺；没有焦点围栏的话 Tab 照样能跑到背景上，
  // 而这个弹窗的确认键是销毁性动作（「放弃修改」）。
  useFocusTrap(open, cardRef)
  if (!open) return null
  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      {/* tabIndex={-1}：焦点要能落在卡片本身。不落在按钮上是刻意的 ——
          落到「放弃修改」上就等于把销毁性动作放在回车键底下。 */}
      <div ref={cardRef} tabIndex={-1} className="confirm-card" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-msg">{message}</div>
        <div className="confirm-actions">
          <button className="ghost" onClick={onCancel}>{cancelLabel}</button>
          <button className="confirm-danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
