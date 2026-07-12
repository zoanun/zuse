import { describe, it, expect, vi, afterEach } from 'vitest'
import type { MemoryItem } from '@zuse/protocol'
import { listMemory, createMemory, updateMemory, deleteMemory, uploadImage, uploadFile, uploadedImageUrl, listModels, persistModel } from './manageApi.js'

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

  // --- Uploads (I2) ---

  it('uploadedImageUrl builds the raw byte endpoint', () => {
    expect(uploadedImageUrl('abc')).toBe('/api/uploads/abc')
    expect(uploadedImageUrl('a b/c')).toBe('/api/uploads/a%20b%2Fc')
  })

  it('uploadImage compresses then POSTs base64 to /api/uploads and returns the ref', async () => {
    const ref = { id: 'u1', name: 'photo.png', mediaType: 'image/png' }
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => ref }))
    // bytes [1,2,3] → base64 "AQID"
    const mockCompress = vi.fn(async () => ({ blob: new Blob([new Uint8Array([1, 2, 3])]), mediaType: 'image/png' }))
    const file = new File([new Uint8Array([9, 9])], 'photo.png', { type: 'image/png' })

    const out = await uploadImage(file, mockCompress)

    expect(out).toEqual(ref)
    expect(mockCompress).toHaveBeenCalledWith(file)
    expect(fn).toHaveBeenCalledWith('/api/uploads', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    }))
    const init = fn.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ mediaType: 'image/png', dataBase64: 'AQID', name: 'photo.png' })
  })

  it('uploadImage throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 413 }))
    const mockCompress = vi.fn(async () => ({ blob: new Blob([new Uint8Array([1])]), mediaType: 'image/jpeg' }))
    const file = new File([new Uint8Array([1])], 'big.jpg', { type: 'image/jpeg' })
    await expect(uploadImage(file, mockCompress)).rejects.toThrow(/upload image failed: 413/)
  })

  it('uploadFile POSTs base64 to /api/uploads/file and returns the ref', async () => {
    const ref = { id: 'f1', name: 'notes.txt', mediaType: 'text/plain' }
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => ref }))
    // bytes [1,2,3] → base64 "AQID"
    const file = new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' })

    const out = await uploadFile(file)

    expect(out).toEqual(ref)
    expect(fn).toHaveBeenCalledWith('/api/uploads/file', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    }))
    const init = fn.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ name: 'notes.txt', mediaType: 'text/plain', dataBase64: 'AQID' })
  })

  it('uploadFile throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 500 }))
    const file = new File([new Uint8Array([1])], 'big.bin', { type: 'application/octet-stream' })
    await expect(uploadFile(file)).rejects.toThrow(/upload file failed: 500/)
  })

  // --- Models (Header switcher) ---

  it('listModels GETs /api/models and returns options + defaultModel', async () => {
    const payload = { options: [{ providerId: 'qwen', model: 'kimi-k2.6' }], defaultModel: 'qwen/kimi-k2.6' }
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => payload }))
    const out = await listModels()
    expect(out).toEqual(payload)
    expect(fn).toHaveBeenCalledWith('/api/models', expect.objectContaining({ credentials: 'same-origin' }))
  })

  it('listModels throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 401 }))
    await expect(listModels()).rejects.toThrow(/list models failed: 401/)
  })

  it('persistModel PUTs /api/model with {providerId, model}', async () => {
    const fn = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    await persistModel('qwen', 'kimi-k2.6')
    expect(fn).toHaveBeenCalledWith('/api/model', expect.objectContaining({
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'qwen', model: 'kimi-k2.6' }),
    }))
  })

  it('persistModel throws on non-ok', async () => {
    mockFetch(async () => ({ ok: false, status: 400 }))
    await expect(persistModel('', '')).rejects.toThrow(/persist model failed: 400/)
  })
})
