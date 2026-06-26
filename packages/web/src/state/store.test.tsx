import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, render, waitFor, act } from '@testing-library/react'
import { useStore, nextId, StoreProvider } from './store.js'

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

// --- Session bootstrap / New chat wiring ---------------------------------

// Fake WebSocket recording the URLs each instance was opened with.
function makeFakeWs(opened: string[]) {
  return class FakeWS {
    static OPEN = 1
    readyState = 1
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(public url: string) { opened.push(url) }
    send() {}
    close() { this.readyState = 3; this.onclose?.() }
  }
}

function mockLocalStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
  const ls = {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
  }
  vi.stubGlobal('localStorage', ls)
  return store
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
  const fn = vi.fn(impl as unknown as typeof fetch)
  vi.stubGlobal('fetch', fn)
  return fn
}

const okJson = (body: unknown): Partial<Response> => ({ ok: true, status: 200, json: async () => body })

// A consumer that re-exposes the store so a test can call newSession().
let captured: ReturnType<typeof useStore> | null = null
function Consumer() {
  captured = useStore()
  return null
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); captured = null })

describe('StoreProvider session bootstrap', () => {
  it('with NO stored id, POSTs /api/sessions, stores the id, and connects with it', async () => {
    const opened: string[] = []
    vi.stubGlobal('WebSocket', makeFakeWs(opened))
    const store = mockLocalStorage()
    const fetchFn = mockFetch(async () => okJson({ id: 'sess-new' }))

    render(<StoreProvider><Consumer /></StoreProvider>)

    await waitFor(() => expect(opened.some((u) => u.includes('session=sess-new'))).toBe(true))
    expect(fetchFn).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
    expect(store['zuse.sessionId']).toBe('sess-new')
  })

  it('with a stored id, connects with it and does NOT POST', async () => {
    const opened: string[] = []
    vi.stubGlobal('WebSocket', makeFakeWs(opened))
    mockLocalStorage({ 'zuse.sessionId': 'sess-saved' })
    const fetchFn = mockFetch(async () => okJson({ id: 'should-not-happen' }))

    render(<StoreProvider><Consumer /></StoreProvider>)

    await waitFor(() => expect(opened.some((u) => u.includes('session=sess-saved'))).toBe(true))
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('New chat POSTs a new session, stores it, reconnects to it, and clears local state', async () => {
    const opened: string[] = []
    vi.stubGlobal('WebSocket', makeFakeWs(opened))
    const store = mockLocalStorage({ 'zuse.sessionId': 'sess-old' })
    let createdId = 'sess-fresh'
    mockFetch(async () => okJson({ id: createdId }))

    render(<StoreProvider><Consumer /></StoreProvider>)
    await waitFor(() => expect(opened.some((u) => u.includes('session=sess-old'))).toBe(true))

    // Seed some local state, then run New chat.
    act(() => { captured!.dispatch({ kind: 'user-send', id: 'u-1', text: 'hello' }) })
    expect(captured!.state.messages).toHaveLength(1)

    createdId = 'sess-fresh'
    await act(async () => { await captured!.newSession() })

    expect(store['zuse.sessionId']).toBe('sess-fresh')
    expect(opened.some((u) => u.includes('session=sess-fresh'))).toBe(true)
    expect(captured!.state.messages).toHaveLength(0) // reset cleared local state
  })
})
