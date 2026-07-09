import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * In-app image viewer: a portaled full-screen overlay showing one image (instead of opening the
 * browser's own image view in a new tab). Click the backdrop or press Escape to close; clicking the
 * image itself does not close. Escape is handled in the capture phase + stopPropagation so it beats
 * any other window Escape handler (e.g. the composer's stop-turn).
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
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
      <img className="lightbox-img" src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-close" aria-label="关闭" onClick={onClose}>×</button>
    </div>,
    document.body,
  )
}
