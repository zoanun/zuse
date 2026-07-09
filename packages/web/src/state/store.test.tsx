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

// Like makeFakeWs but also captures each instance so a test can drive its onmessage.
type FakeSocket = { url: string; onmessage: ((e: { data: string }) => void) | null; onclose: (() => void) | null }
function makeFakeWsCapturing(opened: string[], instances: FakeSocket[]) {
  return class FakeWS {
    static OPEN = 1
    readyState = 1
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(public url: string) { opened.push(url); instances.push(this as unknown as FakeSocket) }
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
    // Bootstrap may GET /api/sessions to populate the sidebar, but must NOT POST a new session.
    expect(fetchFn).not.toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'POST' }))
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

  it('auto-recovers from session_not_found exactly ONCE, then surfaces the error (no create-loop)', async () => {
    const opened: string[] = []
    const instances: FakeSocket[] = []
    vi.stubGlobal('WebSocket', makeFakeWsCapturing(opened, instances))
    mockLocalStorage({ 'zuse.sessionId': 'sess-a' })
    let posts = 0
    mockFetch(async (url, init) => {
      if (url === '/api/sessions' && init?.method === 'POST') { posts++; return okJson({ id: 'sess-recovered' }) }
      if (url === '/api/sessions') return okJson([])
      return okJson({ id: 'x' })
    })

    render(<StoreProvider><Consumer /></StoreProvider>)
    await waitFor(() => expect(opened.some((u) => u.includes('session=sess-a'))).toBe(true))

    const errFrame = JSON.stringify({ type: 'error', code: 'session_not_found', message: 'no session' })
    // First error → one-shot recovery spins up a fresh session and reconnects to it.
    await act(async () => { instances[instances.length - 1]!.onmessage?.({ data: errFrame }) })
    await waitFor(() => expect(posts).toBe(1))
    await waitFor(() => expect(opened.some((u) => u.includes('session=sess-recovered'))).toBe(true))

    // Second error → NO further create; the red error notice surfaces instead of looping.
    await act(async () => { instances[instances.length - 1]!.onmessage?.({ data: errFrame }) })
    await waitFor(() => expect(captured!.state.messages.some((m) => m.role === 'system' && m.noticeKind === 'error')).toBe(true))
    expect(posts).toBe(1) // still one — the loop is broken
  })
})

// --- Session list: refresh / switch / remove -----------------------------

const meta = (id: string, over: Partial<{ title: string; updatedAt: string; messageCount: number }> = {}) => ({
  id, title: over.title ?? '', createdAt: '2026-01-01T00:00:00Z',
  updatedAt: over.updatedAt ?? '2026-01-01T00:00:00Z', cwd: '/', messageCount: over.messageCount ?? 0,
})

describe('StoreProvider session list', () => {
  it('refreshSessions populates sessions from listSessions (GET /api/sessions)', async () => {
    const opened: string[] = []
    vi.stubGlobal('WebSocket', makeFakeWs(opened))
    mockLocalStorage({ 'zuse.sessionId': 'sess-a' })
    const list = [meta('sess-a', { title: 'Alpha' }), meta('sess-b', { title: 'Beta' })]
    mockFetch(async (url) => (url === '/api/sessions' ? okJson(list) : okJson({ id: 'x' })))

    render(<StoreProvider><Consumer /></StoreProvider>)
    // bootstrap calls refreshSessions; wait for it to land
    await waitFor(() => expect(captured!.sessions).toHaveLength(2))
    expect(captured!.sessions.map((s) => s.id)).toEqual(['sess-a', 'sess-b'])
    expect(captured!.currentSessionId).toBe('sess-a')
  })

  it('switchSession reconnects to the new id, resets local state, no-ops on current', async () => {
    const opened: string[] = []
    vi.stubGlobal('WebSocket', makeFakeWs(opened))
    mockLocalStorage({ 'zuse.sessionId': 'sess-a' })
    mockFetch(async (url) => (url === '/api/sessions' ? okJson([meta('sess-a'), meta('sess-b')]) : okJson({ id: 'x' })))

    render(<StoreProvider><Consumer /></StoreProvider>)
    await waitFor(() => expect(opened.some((u) => u.includes('session=sess-a'))).toBe(true))

    act(() => { captured!.dispatch({ kind: 'user-send', id: 'u-1', text: 'hi' }) })
    expect(captured!.state.messages).toHaveLength(1)

    await act(async () => { await captured!.switchSession('sess-b') })
    expect(opened.some((u) => u.includes('session=sess-b'))).toBe(true)
    expect(captured!.currentSessionId).toBe('sess-b')
    expect(captured!.state.messages).toHaveLength(0) // reset

    const openedCount = opened.length
    await act(async () => { await captured!.switchSession('sess-b') }) // same id → no-op
    expect(opened.length).toBe(openedCount)
  })

  it('removeSession deleting the current session switches to the newest other', async () => {
    const opened: string[] = []
    vi.stubGlobal('WebSocket', makeFakeWs(opened))
    mockLocalStorage({ 'zuse.sessionId': 'sess-a' })
    const fn = mockFetch(async (url, init) => {
      if (url === '/api/sessions') return okJson([meta('sess-a'), meta('sess-b')])
      if ((init?.method) === 'DELETE') return okJson({ ok: true })
      return okJson({ id: 'x' })
    })

    render(<StoreProvider><Consumer /></StoreProvider>)
    await waitFor(() => expect(captured!.sessions).toHaveLength(2))

    await act(async () => { await captured!.removeSession('sess-a') })
    expect(fn).toHaveBeenCalledWith('/api/sessions/sess-a', expect.objectContaining({ method: 'DELETE' }))
    expect(captured!.currentSessionId).toBe('sess-b')
    expect(opened.some((u) => u.includes('session=sess-b'))).toBe(true)
  })

  it('removeSession deleting the last session falls back to newSession()', async () => {
    const opened: string[] = []
    vi.stubGlobal('WebSocket', makeFakeWs(opened))
    mockLocalStorage({ 'zuse.sessionId': 'sess-a' })
    const fn = mockFetch(async (url, init) => {
      if (url === '/api/sessions' && (init?.method ?? 'GET') === 'GET') return okJson([meta('sess-a')])
      if (url === '/api/sessions' && init?.method === 'POST') return okJson({ id: 'sess-created' })
      if (init?.method === 'DELETE') return okJson({ ok: true })
      return okJson({ id: 'x' })
    })

    render(<StoreProvider><Consumer /></StoreProvider>)
    await waitFor(() => expect(captured!.sessions).toHaveLength(1))

    await act(async () => { await captured!.removeSession('sess-a') })
    expect(fn).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'POST' }))
    expect(captured!.currentSessionId).toBe('sess-created')
    expect(opened.some((u) => u.includes('session=sess-created'))).toBe(true)
  })

  it('rename PATCHes then refreshes the list', async () => {
    const opened: string[] = []
    vi.stubGlobal('WebSocket', makeFakeWs(opened))
    mockLocalStorage({ 'zuse.sessionId': 'sess-a' })
    const fn = mockFetch(async (url, init) => {
      if (url === '/api/sessions') return okJson([meta('sess-a', { title: 'Renamed' })])
      return okJson({ ok: true })
    })

    render(<StoreProvider><Consumer /></StoreProvider>)
    await waitFor(() => expect(captured!.sessions).toHaveLength(1))

    await act(async () => { await captured!.rename('sess-a', 'Renamed') })
    expect(fn).toHaveBeenCalledWith('/api/sessions/sess-a', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }),
    }))
  })
})
