import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * In-app full-text viewer for a pasted-text attachment: a portaled full-screen overlay showing the
 * text in a scrollable monospace panel (mirrors ImageLightbox). Click the backdrop or press Escape
 * to close; clicking the panel does not close. Escape is capture-phase + stopPropagation so it beats
 * other window Escape handlers (e.g. the composer's stop-turn).
 */
export function TextLightbox({ text, title, onClose }: { text: string; title?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="textbox-panel" onClick={(e) => e.stopPropagation()}>
        {title ? <div className="textbox-title">{title}</div> : null}
        <pre className="textbox-pre">{text}</pre>
      </div>
      <button className="lightbox-close" aria-label="关闭" onClick={onClose}>×</button>
    </div>,
    document.body,
  )
}
