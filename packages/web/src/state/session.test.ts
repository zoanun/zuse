import { describe, it, expect, vi, afterEach } from 'vitest'
import { listSessions, deleteSession, renameSession, createSession } from './session.js'

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
  const fn = vi.fn(impl as unknown as typeof fetch)
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('session API client', () => {
  it('listSessions GETs /api/sessions and returns the parsed array', async () => {
    const meta = [{ id: 'a', title: 'A', createdAt: '', updatedAt: '', cwd: '/', messageCount: 1 }]
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => meta }))
    const out = await listSessions()
    expect(out).toEqual(meta)
    expect(fn).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ credentials: 'same-origin' }))
    // no explicit method → defaults to GET
    const init = fn.mock.calls[0]![1] as RequestInit | undefined
    expect(init?.method).toBeUndefined()
  })

  it('listSessions throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 500 }))
    await expect(listSessions()).rejects.toThrow(/list sessions failed: 500/)
  })

  it('deleteSession DELETEs /api/sessions/<encoded id>', async () => {
    const fn = mockFetch(async () => ({ ok: true, status: 200 }))
    await deleteSession('a/b c')
    expect(fn).toHaveBeenCalledWith('/api/sessions/' + encodeURIComponent('a/b c'), expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }))
  })

  it('deleteSession throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 400 }))
    await expect(deleteSession('x')).rejects.toThrow(/delete session failed: 400/)
  })

  it('renameSession PATCHes /api/sessions/<id> with a {title} body', async () => {
    const fn = mockFetch(async () => ({ ok: true, status: 200 }))
    await renameSession('sess-1', 'Hello')
    expect(fn).toHaveBeenCalledWith('/api/sessions/sess-1', expect.objectContaining({
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Hello' }),
    }))
  })

  it('renameSession throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 400 }))
    await expect(renameSession('x', 't')).rejects.toThrow(/rename session failed: 400/)
  })

  it('createSession POSTs and returns the id (regression — still works)', async () => {
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ id: 'sess-new' }) }))
    const id = await createSession()
    expect(id).toBe('sess-new')
    expect(fn).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
  })
})
