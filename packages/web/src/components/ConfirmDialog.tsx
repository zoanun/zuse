import { useEffect } from 'react'
import { createPortal } from 'react-dom'

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
  if (!open) return null
  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-card" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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
