import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { getTheme, toggleTheme, useTheme } from './theme.js'

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-theme') })

describe('theme', () => {
  it('defaults to light', () => { expect(getTheme()).toBe('light') })
  it('reflects a pre-set data-theme attribute (the preload path)', () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    expect(getTheme()).toBe('dark')
  })
  it('toggles and persists + sets attribute', () => {
    const next = toggleTheme()
    expect(next).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('zuse-theme')).toBe('dark')
    expect(toggleTheme()).toBe('light')
  })
  it('useTheme reacts to a data-theme change from anywhere (MutationObserver)', async () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current).toBe('light')
    act(() => { toggleTheme() }) // Header's toggle only re-renders Header — the hook must self-update
    await waitFor(() => expect(result.current).toBe('dark'))
  })
})
