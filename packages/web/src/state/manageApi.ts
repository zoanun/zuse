import type { MemoryItem, ProjectInfo, PersonaItem, PersonasState, SkillItem, SkillsState, UsageStats, DirListing, FileEntry, FilePreview, WriteFileResult, DirNav, McpServerInfo, UploadedImageRef } from '@zuse/protocol'
import { request, RequestError } from './session.js'
import { compressImage } from './imageCompress.js'

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

/** GET /api/projects → known {slug, cwd} pairs (for the project picker labels). Throws on non-ok. */
export async function listProjects(): Promise<ProjectInfo[]> {
  const r = await request('/api/projects', {}, 'list projects')
  return (await r.json()) as ProjectInfo[]
}

// --- Personas (M2) ---

const personaPath = (id: string): string => '/api/personas/' + encodeURIComponent(id)

/** GET /api/personas → { personas, activeId }. Throws on non-ok. */
export async function listPersonas(): Promise<PersonasState> {
  const r = await request('/api/personas', {}, 'list personas')
  return (await r.json()) as PersonasState
}

/** POST /api/personas → the created PersonaItem. Throws on non-ok. */
export async function createPersona(body: { name: string; content: string }): Promise<PersonaItem> {
  const r = await request('/api/personas', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'create persona')
  return (await r.json()) as PersonaItem
}

/** PATCH /api/personas/<id> → the updated PersonaItem. Throws on non-ok. */
export async function updatePersona(id: string, body: { name?: string; content?: string }): Promise<PersonaItem> {
  const r = await request(personaPath(id), { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'update persona')
  return (await r.json()) as PersonaItem
}

/** DELETE /api/personas/<id>. Throws on non-ok. */
export async function deletePersona(id: string): Promise<void> {
  await request(personaPath(id), { method: 'DELETE' }, 'delete persona')
}

/** POST /api/personas/activate with {id} (null clears). Throws on non-ok. */
export async function activatePersona(id: string | null): Promise<void> {
  await request('/api/personas/activate', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id }) }, 'activate persona')
}

// --- Skills (M3) ---

/** GET /api/skills → { skills }. Throws on non-ok. */
export async function listSkills(): Promise<SkillsState> {
  const r = await request('/api/skills', {}, 'list skills')
  return (await r.json()) as SkillsState
}

/** PATCH /api/skills/<name> → the updated SkillItem. Throws on non-ok (404 unknown name). */
export async function updateSkill(name: string, body: { description?: string; body?: string; enabled?: boolean }): Promise<SkillItem> {
  const r = await request('/api/skills/' + encodeURIComponent(name), { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'update skill')
  return (await r.json()) as SkillItem
}

// --- Usage (M5) ---

/** GET /api/usage → aggregated token usage across all sessions. Throws on non-ok. */
export async function getUsage(): Promise<UsageStats> {
  const r = await request('/api/usage', {}, 'get usage')
  return (await r.json()) as UsageStats
}

// --- Files (M7) ---

/** GET /api/files?dir=<rel>[&cwd=<abs>] → a directory's immediate children. Throws on non-ok. */
export async function listDir(dir: string, cwd?: string): Promise<DirListing> {
  const qs = new URLSearchParams({ dir })
  if (cwd) qs.set('cwd', cwd)
  const r = await request('/api/files?' + qs.toString(), {}, 'list directory')
  return (await r.json()) as DirListing
}

/** GET /api/files/search?q=<query>[&cwd=<abs>] → fuzzy filename hits (files only, capped). */
export async function searchFiles(q: string, cwd?: string): Promise<FileEntry[]> {
  const qs = new URLSearchParams({ q })
  if (cwd) qs.set('cwd', cwd)
  const r = await request('/api/files/search?' + qs.toString(), {}, 'search files')
  return (await r.json()) as FileEntry[]
}

/** GET /api/files/content?path=<rel>[&cwd=<abs>] → a file preview. Throws on non-ok. */
export async function readFilePreview(path: string, cwd?: string): Promise<FilePreview> {
  const qs = new URLSearchParams({ path })
  if (cwd) qs.set('cwd', cwd)
  const r = await request('/api/files/content?' + qs.toString(), {}, 'read file')
  return (await r.json()) as FilePreview
}

/** Thrown by writeFile on a 409 (file changed on disk since load) so the UI can offer force-overwrite. */
export class FileConflictError extends Error {
  constructor() { super('file changed on disk'); this.name = 'FileConflictError' }
}

/**
 * PUT /api/files/content — write a file. `mustCreate` is exclusive-create (won't overwrite; makes
 * parent dirs). A 409 means "already changed on disk" for an edit (→ FileConflictError, offer
 * overwrite) but "already exists" for a create (→ a plain error, no overwrite affordance).
 */
export async function writeFile(path: string, content: string, cwd?: string, opts: { expectMtimeMs?: number; force?: boolean; mustCreate?: boolean } = {}): Promise<WriteFileResult> {
  const qs = new URLSearchParams()
  if (cwd) qs.set('cwd', cwd)
  const body = JSON.stringify({ path, content, expectMtimeMs: opts.expectMtimeMs, force: opts.force, mustCreate: opts.mustCreate })
  try {
    const r = await request('/api/files/content' + (qs.toString() ? '?' + qs.toString() : ''), { method: 'PUT', headers: JSON_HEADERS, body }, 'write file')
    return (await r.json()) as WriteFileResult
  } catch (e) {
    if (e instanceof RequestError && e.status === 409) throw opts.mustCreate ? new Error('文件已存在，未覆盖') : new FileConflictError()
    throw e
  }
}

/** DELETE /api/files/content?path=…&cwd=… — delete a file. */
export async function deleteFile(path: string, cwd?: string): Promise<void> {
  const qs = new URLSearchParams({ path })
  if (cwd) qs.set('cwd', cwd)
  await request('/api/files/content?' + qs.toString(), { method: 'DELETE' }, 'delete file')
}

/** URL for the raw byte endpoint — inline <img>/<iframe> src (size-capped, same-origin cookie sent). */
export function rawFileUrl(path: string, cwd?: string): string {
  const qs = new URLSearchParams({ path })
  if (cwd) qs.set('cwd', cwd)
  return '/api/files/raw?' + qs.toString()
}

/** Download href for the raw endpoint — download=1 bypasses the inline cap and forces attachment. */
export function rawDownloadUrl(path: string, cwd?: string): string {
  const qs = new URLSearchParams({ path, download: '1' })
  if (cwd) qs.set('cwd', cwd)
  return '/api/files/raw?' + qs.toString()
}

/** GET /api/dirs?path=<abs> → subdir navigation for the cwd picker (S3). Throws on non-ok. */
export async function navigateDirs(path?: string): Promise<DirNav> {
  const r = await request('/api/dirs' + (path ? '?path=' + encodeURIComponent(path) : ''), {}, 'navigate dirs')
  return (await r.json()) as DirNav
}

// --- Uploads (I2) ---

/** Blob → 裸 base64（去掉 "data:...;base64," 前缀）。用 FileReader.readAsDataURL，jsdom/浏览器皆可用。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 上传图片：客户端压缩 → base64 → POST /api/uploads → { id, name, mediaType }。
 * `compress` 默认 compressImage，可注入以便测试（默认参数做依赖注入，不引框架）。
 */
export async function uploadImage(file: File, compress = compressImage): Promise<UploadedImageRef> {
  const { blob, mediaType } = await compress(file)
  const dataBase64 = await blobToBase64(blob)
  const r = await request('/api/uploads', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ mediaType, dataBase64, name: file.name }) }, 'upload image')
  return (await r.json()) as UploadedImageRef
}

/** 上传图片的读取 URL（气泡缩略图 src、同源 cookie）。 */
export function uploadedImageUrl(id: string): string {
  return '/api/uploads/' + encodeURIComponent(id)
}

// --- Models (Header switcher) ---

export interface ModelOption { providerId: string; model: string }
export interface ModelsResponse { options: ModelOption[]; defaultModel: string | null }

/** GET /api/models → configured {providerId, model} options + the persisted default. Throws on non-ok. */
export async function listModels(): Promise<ModelsResponse> {
  const r = await request('/api/models', {}, 'list models')
  return (await r.json()) as ModelsResponse
}

/** PUT /api/model → persist the default model to project settings. Throws on non-ok. */
export async function persistModel(providerId: string, model: string): Promise<void> {
  await request('/api/model', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ providerId, model }) }, 'persist model')
}

// --- MCP servers (M4) ---

export interface AddMcpBody { name: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string }

/** GET /api/mcp → McpServerInfo[] (configured + live status + tools). Throws on non-ok. */
export async function listMcp(): Promise<McpServerInfo[]> {
  const r = await request('/api/mcp', {}, 'list mcp')
  return (await r.json()) as McpServerInfo[]
}

/** POST /api/mcp → add/overwrite a server config (restart to apply). Throws on non-ok. */
export async function addMcp(body: AddMcpBody): Promise<void> {
  await request('/api/mcp', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'add mcp server')
}

/** DELETE /api/mcp/<name>. Throws on non-ok. */
export async function deleteMcp(name: string): Promise<void> {
  await request('/api/mcp/' + encodeURIComponent(name), { method: 'DELETE' }, 'delete mcp server')
}

/** POST /api/mcp/reconnect → live reconnect of ALL servers from current settings. */
export async function reconnectMcp(): Promise<void> {
  await request('/api/mcp/reconnect', { method: 'POST' }, 'reconnect mcp')
}

/** POST /api/mcp/<name>/reconnect → live reconnect of a single server. */
export async function reconnectMcpServer(name: string): Promise<void> {
  await request('/api/mcp/' + encodeURIComponent(name) + '/reconnect', { method: 'POST' }, 'reconnect mcp server')
}
