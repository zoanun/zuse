/**
 * @zuse/protocol — web ↔ server 的唯一线缆契约（type-only，零运行时）。
 *
 * 注意：这里从 @zuse/core 只做 `export type` 转导。core 是 Node 引擎（node:fs /
 * better-sqlite3 等），不能进浏览器 bundle；但 `export type` 在编译期被擦除，web
 * 侧 `import type` 这些类型不会把任何 core 运行时拖进 bundle。详见 F3 设计 §2。
 */
import type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

export type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

/** 快照消息的单个内容片段（镜像 web 侧 Part 形状；tool-result 用 isError，非 is_error）。 */
export type SnapshotPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; name: string; output: string; isError: boolean }

/** 快照消息（用于检查点时间轴恢复）。 */
export interface SnapshotMessage {
  /** 稳定账本消息 id（前端 keying / 滚动 / 搜索跳转 / checkpoint 关联的唯一键）。 */
  id: string
  role: 'user' | 'assistant'
  parts: SnapshotPart[]
  /** 中断标记消息：前端据此渲染成系统提示（非用户气泡），标记文本 part 已在投影时略去。 */
  interrupt?: boolean
  /** 若本条用户消息开启了某次 turn，则带上该 turn 检查点的 hash（供前端渲染逐条 revert）。 */
  checkpointId?: string
  /** 回合中插话（steer）气泡：服务端据账本消息的结构化 steer 字段还原出的用户原话，前端渲染 "↪ 插话"。 */
  steer?: boolean
  /** 附着在本条消息上的附件（图片或粘贴文本）（快照投影用；不含 base64）。 */
  attachments?: MessageAttachment[]
}

/** 一次上传后的图片引用（客户端持有、随 send 上行）。 */
export interface UploadedImageRef {
  id: string
  name: string
  mediaType: string
}

/** 一段随 send 内联上行的粘贴文本（客户端持有，不经 HTTP 预上传）。 */
export interface PastedTextInput {
  id: string    // 客户端生成，用于卡片 key / 删除 / attachment id
  text: string  // 粘贴全文，已规范化 \r→\n（入栈即规范化，展示/计数/发送口径统一）
}

/** 一次上传后的任意文件引用（客户端持有、随 send 上行）。 */
export interface UploadedFileRef {
  id: string
  name: string
  mediaType: string
}

/** 附着在一条消息上的附件（图片或粘贴文本；快照投影用）。图片不含 base64（字节在磁盘）；
 *  粘贴文本的全文内联在 `text` 字段。 */
export interface MessageAttachment {
  id: string
  name: string
  mediaType: string
  /** direct=图直传 / parsed=图解析转述 / pasted=粘贴长文本 / file=上传的任意文件（只带 name，路径发送时服务端现算）。 */
  route?: 'direct' | 'parsed' | 'pasted' | 'file'
  /** 解析路径下模型看到的文字描述（供气泡折叠展示）；direct 无。 */
  description?: string
  /** route==='pasted' 时的粘贴全文（内联持久化 + 随 snapshot 下发；图片路径无此字段）。 */
  text?: string
}

/** 检查点轻量摘要。 */
export interface CheckpointLite { id: string; label: string }

/** 会话列表项的轻量元数据（权威源；server 的 sessionStore.ts `import type` 复用）。 */
export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  cwd: string
  messageCount: number
}

/** 记忆条目 DTO(权威源;server 的 MemoryService `import type` 复用,形状 = MemoryRow)。 */
export interface MemoryItem {
  id: number
  type: 'user' | 'project' | 'insight' | 'reference'
  content: string
  project: string
  hook: string
  createdAt: string
  updatedAt: string
}

/** A known project: its memory `project` slug (cwd-slug) ↔ the real working directory. */
export interface ProjectInfo {
  slug: string
  cwd: string
}

/** A named persona (USER.md-style prompt layer), one of which may be active (M2). */
export interface PersonaItem {
  id: string
  name: string
  content: string
  createdAt: string
  updatedAt: string
}

/** All personas plus which is active (null = none → only the read-only core prompt). */
export interface PersonasState {
  personas: PersonaItem[]
  activeId: string | null
}

/** A loaded skill (M3 management panel). name is the stable identity/key; description is the
 * model's trigger basis; body is the SKILL.md instructions. source: where the SKILL.md lives. */
export interface SkillItem {
  name: string
  description: string
  body: string
  /** user = ~/.zuse/skills; project = a .zuse/skills along the cwd chain; builtin = compiled into zuse. */
  source: 'user' | 'project' | 'builtin'
  /** false = listed in the panel but excluded from the Skill tool (new sessions). */
  enabled: boolean
}

/** All loaded skills (M3). */
export interface SkillsState {
  skills: SkillItem[]
}

/** Token usage for one model, summed across all sessions that recorded it (M5). */
export interface UsageModelStat {
  /** The recorded model id; 'unknown' when a session never recorded one. */
  model: string
  /** How many sessions contributed. */
  sessions: number
  usage: Usage
}

/** Token usage for one session (M5). */
export interface UsageSessionStat {
  id: string
  title: string
  model: string
  updatedAt: string
  usage: Usage
}

/** Aggregated token usage across all persisted sessions (M5 dashboard). No cost — token-only. */
export interface UsageStats {
  /** Grand total across every session. */
  total: Usage
  sessionCount: number
  /** Per-model breakdown, biggest first. */
  byModel: UsageModelStat[]
  /** Per-session breakdown, biggest first. */
  sessions: UsageSessionStat[]
}

/** One entry in a directory listing (M7 file tree). path is posix, relative to the project root. */
export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir'
}

/** A directory's immediate children (M7, lazy-loaded one level at a time). */
export interface DirListing {
  /** The listed directory, relative to the project root ('' = root). */
  path: string
  /** Absolute path of the project root (the browser's cwd) — shown as the tree header. */
  root: string
  entries: FileEntry[]
}

/** A node in the working-directory picker (S3): the listed dir, its parent, subdirs, and drives.
 * Unrestricted (not root-locked like the M7 browser) — it's a chooser for a new session's cwd. */
export interface DirNav {
  /** Absolute path of the listed directory. */
  path: string
  /** Absolute parent path, or null at a filesystem/drive root. */
  parent: string | null
  /** Immediate subdirectories (absolute paths), alphabetical. */
  dirs: { name: string; path: string }[]
  /** Windows drive roots (e.g. ["C:\\", "D:\\"]) for the drive switcher; [] on POSIX. */
  drives: string[]
}

/** A file's content for read-only preview (M7). Large files are truncated; binary ones aren't read. */
export interface FilePreview {
  path: string
  /** UTF-8 text; empty when binary. */
  content: string
  /** True when content was cut at the size cap. */
  truncated: boolean
  /** True when the file looked binary (NUL byte) — content is then empty. */
  binary: boolean
  /** Full file size in bytes. */
  size: number
  /** Last-modified time (ms since epoch) — used for save-time conflict detection. */
  mtimeMs: number
}

/** Result of writing a file (edit or create). */
export interface WriteFileResult {
  path: string
  size: number
  mtimeMs: number
}

/** Body for PUT /api/files/content. expectMtimeMs absent = no conflict check; force skips it. */
export interface WriteFileBody {
  path: string
  content: string
  expectMtimeMs?: number
  force?: boolean
  /** Exclusive create: refuse to overwrite an existing file, and make missing parent dirs. */
  mustCreate?: boolean
}

/** An MCP server's config + live connection status + its tools (M4 management panel). */
export interface McpServerInfo {
  name: string
  /** connected = live this session; failed = configured but connect errored; configured = in settings, not yet connected (restart to apply). */
  status: 'connected' | 'failed' | 'configured'
  /** The stdio command (or omitted for URL/SSE servers), for display. */
  command?: string
  args?: string[]
  /** Connect error message when status === 'failed'. */
  error?: string
  /** Tools exposed by the server (only populated when connected). */
  tools: Array<{ name: string; description?: string }>
}

/** One labelled layer of the assembled system prompt (read-only "effective prompt" view). */
export interface PromptSection {
  /** Where it came from: 'core' | 'environment' | 'SYSTEM.md' | 'ZUSE.md' | 'MEMORY.md' | 'persona' | … */
  source: string
  content: string
}

/** 轻量 todo —— 与 server 内部状态镜像。 */
export interface TodoItemLite {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 已推给前端但尚未解决的权限请求。 */
export interface PendingPermissionLite {
  id: string
  req: PermissionRequest
}

/**
 * SessionManager 可发射给订阅者的全部事件。成员全部 JSON 可序列化（无函数/类实例），
 * 字段名镜像 @zuse/core 的 StreamEvent，便于零变换转发。
 */
export type SessionEvent =
  | { type: 'message-start'; id: string; model: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; id: string; name: string; input: unknown; invalid_args?: string }
  | { type: 'tool-result'; id: string; name: string; output: string; is_error: boolean }
  | { type: 'message-stop'; stop_reason: string; usage: Usage }
  | { type: 'turn-start'; isResend: boolean }
  | { type: 'turn-end' }
  | { type: 'usage-update'; totalUsage: Usage | undefined }
  | { type: 'context-update'; contextTokens: number | undefined; contextWindow: number | undefined }
  | { type: 'permission-request'; id: string; req: PermissionRequest }
  | { type: 'permission-resolved'; id: string; verdict: PermissionVerdict }
  | { type: 'compaction-start'; keep: number }
  | { type: 'compaction-done'; summaryText: string }
  | { type: 'failover'; fromModel: string; toModel: string; reason: string }
  // Authoritative model truth after a switch-model: the server emits this with the model actually
  // in effect (new on success, unchanged old on a failed rebuild) so the client's optimistic Header
  // value is corrected. Distinct from the reducer's local `kind:'model-changed'` optimistic action.
  | { type: 'model-changed'; model: string; providerId: string }
  | { type: 'checkpoint-recorded'; id: string; messageIndex: number; anchorMessageId: string; label: string }
  | { type: 'memory-notice'; text: string }
  | { type: 'todos-update'; todos: TodoItemLite[] }
  | { type: 'cwd-change'; cwd: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; category?: string }
  | { type: 'aborted' }
  | { type: 'model-select-needed'; reason: string }
  | { type: 'reverted'; checkpointId: string }
  | { type: 'user-echo'; text: string; messageId: string; steer?: boolean; attachments?: MessageAttachment[] }
  | { type: 'title-changed'; title: string }
  // 用户在"啥都还没生成"时中断：账本不留痕，改让 web 把这段原始输入退回输入框供编辑（CC rewind）。
  | { type: 'restore-input'; text: string }

/** 连上时发给晚加入订阅者的全量状态快照。 */
export interface SessionSnapshot {
  sessionId: string
  isThinking: boolean
  model: string
  /** Provider id of the active model — lets the UI disambiguate same-named models across providers. */
  modelProviderId: string
  cwd: string
  totalUsage: Usage | undefined
  contextTokens: number | undefined
  contextWindow: number | undefined
  todos: TodoItemLite[]
  pendingPermissions: PendingPermissionLite[]
  messageCount: number
  messages: SnapshotMessage[]
  checkpoints: CheckpointLite[]
}

/** 上行 client → server。 */
export type ClientMessage =
  | { type: 'send'; text: string; messageId: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[]; files?: UploadedFileRef[] }
  | { type: 'interrupt' }
  | { type: 'steer'; text: string; messageId: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[]; files?: UploadedFileRef[] }
  | { type: 'permission-reply'; id: string; verdict: PermissionVerdict }
  | { type: 'switch-model'; providerId: string; model: string }
  | { type: 'reset-session' }
  | { type: 'revert'; checkpointId: string }
  | { type: 'retry' }
  | { type: 'compact' }

/** 下行 server → client。 */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'event'; event: SessionEvent }
  | { type: 'error'; message: string; code?: string }

/** 一条命中的高亮片段：命中处前后各截一段，match 为命中原文（保留大小写）。 */
export interface SearchSnippet {
  pre: string
  match: string
  post: string
}

/** 一条消息级命中。 */
export interface SearchHit {
  /** 命中消息的稳定 id（跳转按此定位，避免 msgIndex 序号漂移）。 */
  id: string
  msgIndex: number
  role: 'user' | 'assistant'
  snippet: SearchSnippet
}

/** 一个会话内的搜索结果（命中按会话分组）。 */
export interface SessionSearchResult {
  session: { id: string; title: string; cwd: string; updatedAt: string }
  /** 已封顶的命中列表（最多 perSessionCap 条）。 */
  hits: SearchHit[]
  /** 该会话总命中数；可能 > hits.length。 */
  hitCount: number
}

export type CronPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'
export type CronRunStatus = 'running' | 'success' | 'failed'

export interface CronTask {
  id: string
  name: string
  cron: string            // 标准 5 段 cron 表达式
  prompt: string
  cwd: string
  permissionMode: CronPermissionMode
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** 列表项：任务 + 计算出的下次执行时间（croner nextRun，非持久化）。 */
export interface CronTaskWithNext extends CronTask {
  nextRun: string | null
}

/** 建/改任务的请求体（id/时间戳由服务端填）。 */
export interface CronTaskInput {
  name: string
  cron: string
  prompt: string
  cwd?: string
  permissionMode?: CronPermissionMode
  enabled?: boolean
}

export interface CronRun {
  id: string
  taskId: string
  startedAt: string
  finishedAt?: string
  status: CronRunStatus
  sessionId: string
  summary?: string
  error?: string
}

/** 某次执行详情：run 记录 + 那次会话的消息投影（复用现有 SnapshotMessage 渲染）。 */
export interface CronRunDetail {
  run: CronRun
  messages: SnapshotMessage[]   // SnapshotMessage 已在本文件定义
}
