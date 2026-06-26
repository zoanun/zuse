import { describe, it, expect, vi, afterEach } from 'vitest'
import type { MemoryItem } from '@zuse/protocol'
import { listMemory, createMemory, updateMemory, deleteMemory } from './manageApi.js'

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
  const fn = vi.fn(impl as unknown as typeof fetch)
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const item: MemoryItem = {
  id: 1, type: 'user', content: 'hi', project: '', hook: '', createdAt: '', updatedAt: '',
}

describe('manageApi', () => {
  it('listMemory GETs /api/memory with no query when no params', async () => {
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => [item] }))
    const out = await listMemory()
    expect(out).toEqual([item])
    expect(fn).toHaveBeenCalledWith('/api/memory', expect.objectContaining({ credentials: 'same-origin' }))
    const init = fn.mock.calls[0]![1] as RequestInit | undefined
    expect(init?.method).toBeUndefined()
  })

  it('listMemory builds a query string from project/q/limit', async () => {
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => [] }))
    await listMemory({ project: 'web app', q: 'foo', limit: 5 })
    const url = fn.mock.calls[0]![0] as string
    expect(url.startsWith('/api/memory?')).toBe(true)
    expect(url).toContain('project=web+app')
    expect(url).toContain('q=foo')
    expect(url).toContain('limit=5')
  })

  it('listMemory throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 500 }))
    await expect(listMemory()).rejects.toThrow(/list memory failed: 500/)
  })

  it('createMemory POSTs JSON body and returns the item', async () => {
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => item }))
    const out = await createMemory({ type: 'user', content: 'hi' })
    expect(out).toEqual(item)
    expect(fn).toHaveBeenCalledWith('/api/memory', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user', content: 'hi' }),
    }))
  })

  it('createMemory throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 400 }))
    await expect(createMemory({ type: 'user', content: '' })).rejects.toThrow(/create memory failed: 400/)
  })

  it('updateMemory PATCHes /api/memory/<id> with body', async () => {
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => item }))
    await updateMemory(7, { content: 'new' })
    expect(fn).toHaveBeenCalledWith('/api/memory/7', expect.objectContaining({
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'new' }),
    }))
  })

  it('updateMemory throws on 404 unknown id', async () => {
    mockFetch(async () => ({ ok: false, status: 404 }))
    await expect(updateMemory(99, { content: 'x' })).rejects.toThrow(/update memory failed: 404/)
  })

  it('deleteMemory DELETEs /api/memory/<id>', async () => {
    const fn = mockFetch(async () => ({ ok: true, status: 200 }))
    await deleteMemory(3)
    expect(fn).toHaveBeenCalledWith('/api/memory/3', expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }))
  })

  it('deleteMemory throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 500 }))
    await expect(deleteMemory(3)).rejects.toThrow(/delete memory failed: 500/)
  })
})
