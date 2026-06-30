import { useEffect, useRef, useState } from 'react'

/**
 * Copy text to the clipboard with a brief `copied` acknowledgement (1.5s), failing silently
 * if the clipboard API is unavailable (insecure context). Shared by the code-block copy button
 * and the per-reply copy button so the timeout/guard behaviour lives in one place.
 *
 * The reset timer's handle is kept so it can be cleared on unmount (these buttons live in the
 * message list, which unmounts on session switch/reset) and before re-arming on a rapid second
 * copy — otherwise the timeout fires setCopied on an unmounted component / leaks a stray timer.
 */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const copy = (text: string): void => {
    if (!text) return
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  }
  return { copied, copy }
}
