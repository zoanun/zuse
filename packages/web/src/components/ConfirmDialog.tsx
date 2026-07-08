import { createPortal } from 'react-dom'

/**
 * App-styled modal confirm (replaces window.confirm). Renders nothing when closed; portaled to
 * body so it floats above the drawer. Clicking the backdrop cancels.
 */
export function ConfirmDialog({ open, message, confirmLabel = '放弃修改', cancelLabel = '取消', onConfirm, onCancel }: {
  open: boolean
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
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
