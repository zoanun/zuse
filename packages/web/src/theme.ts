import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

/**
 * Reactive theme: re-renders the consumer whenever data-theme changes on <html>. Needed by
 * components that render theme-dependent output outside the Header (which owns the toggle and
 * only re-renders itself) — e.g. the CodeMirror editor's light/dark theme prop.
 */
export function useTheme(): Theme {
  const [theme, setThemeState] = useState<Theme>(getTheme)
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeState(getTheme()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])
  return theme
}

export function setTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t)
  try { localStorage.setItem('zuse-theme', t) } catch { /* ignore */ }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'light' ? 'dark' : 'light'
  setTheme(next)
  return next
}
