import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useStore, nextId } from './store.js'

describe('store', () => {
  it('useStore throws when used outside StoreProvider', () => {
    // React logs the thrown render error; silence it to keep test output clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useStore())).toThrow(/StoreProvider/)
    spy.mockRestore()
  })

  it('nextId produces unique, prefixed, monotonic ids', () => {
    const a = nextId('u')
    const b = nextId('u')
    expect(a).not.toBe(b)
    expect(a.startsWith('u-')).toBe(true)
    expect(b.startsWith('u-')).toBe(true)
  })
})
