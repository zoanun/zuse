import type { MemoryItem } from '@zuse/protocol'
import { request } from './session.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

/** Body accepted when creating a memory (project/hook optional → default global/empty). */
export interface CreateMemoryBody {
  type: MemoryItem['type']
  content: string
  project?: string
  hook?: string
}

/** Body accepted when patching a memory (all fields optional). */
export interface UpdateMemoryBody {
  type?: MemoryItem['type']
  content?: string
  hook?: string
  project?: string
}

const memoryPath = (id: number): string => '/api/memory/' + encodeURIComponent(String(id))

/** GET /api/memory with optional ?project=&q=&limit= → MemoryItem[]. Throws on non-ok. */
export async function listMemory(params: { project?: string; q?: string; limit?: number } = {}): Promise<MemoryItem[]> {
  const qs = new URLSearchParams()
  if (params.project !== undefined) qs.set('project', params.project)
  if (params.q !== undefined) qs.set('q', params.q)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  const query = qs.toString()
  const r = await request('/api/memory' + (query ? '?' + query : ''), {}, 'list memory')
  return (await r.json()) as MemoryItem[]
}

/** POST /api/memory → the created MemoryItem. Throws on non-ok. */
export async function createMemory(body: CreateMemoryBody): Promise<MemoryItem> {
  const r = await request('/api/memory', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'create memory')
  return (await r.json()) as MemoryItem
}

/** PATCH /api/memory/<id> → the updated MemoryItem. Throws on non-ok (404 unknown id). */
export async function updateMemory(id: number, body: UpdateMemoryBody): Promise<MemoryItem> {
  const r = await request(memoryPath(id), { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'update memory')
  return (await r.json()) as MemoryItem
}

/** DELETE /api/memory/<id>. Throws on non-ok. */
export async function deleteMemory(id: number): Promise<void> {
  await request(memoryPath(id), { method: 'DELETE' }, 'delete memory')
}
