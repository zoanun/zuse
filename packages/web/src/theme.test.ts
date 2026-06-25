import { describe, it, expect, beforeEach } from 'vitest'
import { getTheme, toggleTheme } from './theme.js'

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-theme') })

describe('theme', () => {
  it('defaults to light', () => { expect(getTheme()).toBe('light') })
  it('toggles and persists + sets attribute', () => {
    const next = toggleTheme()
    expect(next).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('zuse-theme')).toBe('dark')
    expect(toggleTheme()).toBe('light')
  })
})
