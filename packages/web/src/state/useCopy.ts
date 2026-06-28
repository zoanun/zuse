import { useState } from 'react'

/**
 * Copy text to the clipboard with a brief `copied` acknowledgement (1.5s), failing silently
 * if the clipboard API is unavailable (insecure context). Shared by the code-block copy button
 * and the per-reply copy button so the timeout/guard behaviour lives in one place.
 */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const copy = (text: string): void => {
    if (!text) return
    void navigator.clipboard?.writeText(text).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500) },
      () => {},
    )
  }
  return { copied, copy }
}
