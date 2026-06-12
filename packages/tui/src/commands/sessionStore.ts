import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Conversation, type ConversationSnapshot, type Message, type Usage } from '@zuse/core'
import { cwdSlug } from '@zuse/tools'

// cwd → 目录段的编码与影子快照(@zuse/tools snapshot.ts)共用一份,两边目录对得上号。
export { cwdSlug }

/**
 * 已保存会话的存放根(测试经 ZUSE_SESSIONS_DIR 注入临时目录):
 *   <root>/<name>.json                        命名存档(/save /load,v1 格式)
 *   <root>/auto/<cwd-slug>/<session-id>.json  自动会话(按 cwd 分组,v2 格式,Phase 10)
 */
function sessionsRoot(): string {
  return process.env.ZUSE_SESSIONS_DIR ?? join(homedir(), '.zuse', 'sessions')
}

/**
 * 把用户提供的名字收缩成单个安全的路径段。剥掉任何可能逃出 sessions 目录的
 * 字符（斜杠、".."），这样 /save 和 /load 就无法被用来做路径穿越。
 */
function safeName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9_.-]/g, '_')
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`无效的会话名："${name}"`)
  }
  return cleaned
}

function sessionPath(name: string): string {
  return join(sessionsRoot(), `${safeName(name)}.json`)
}

/** 序列化并写入一个会话。返回它写入的文件路径。 */
export async function saveConversation(name: string, conv: Conversation): Promise<string> {
  await mkdir(sessionsRoot(), { recursive: true })
  const path = sessionPath(name)
  await writeFile(path, JSON.stringify(conv.toJSON(), null, 2), 'utf8')
  return path
}

/** 读取并反序列化一个已保存的会话。若不存在或已损坏则抛错。 */
export async function loadConversation(name: string): Promise<Conversation> {
  const path = sessionPath(name)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(`找不到名为 "${safeName(name)}" 的已保存会话`)
  }
  const data = JSON.parse(raw) as ConversationSnapshot
  return Conversation.fromJSON(data)
}

// ---------------------------------------------------------------------------
// 自动会话(Phase 10A):按 cwd 分组、每回合自动保存、--continue/--resume 续接。
// ---------------------------------------------------------------------------

/**
 * 会话检查点(Phase 12):每个用户回合开始前的影子 git 快照锚点。
 * /revert = restore(hash) 回滚工作区 + 账本截断到 messageIndex。
 */
export interface SessionCheckpoint {
  /** 该回合用户消息在 messages 里的下标(回滚 = 截到此下标;出错回合可等于当时长度,截断为 no-op)。 */
  messageIndex: number
  /** 影子 git commit hash。 */
  hash: string
  /** 打点时间(ISO)。 */
  at: string
  /** 该回合用户输入的前 80 字符 —— /revert 列表的展示标签。 */
  label: string
}

/**
 * 自动会话的文件格式。命名存档维持 v1 不动;v2 带元数据(Phase 10),
 * v3 增 checkpoints(Phase 12)。读端 v2/v3 都收,v2 的 checkpoints 视为空。
 */
export interface SessionRecord {
  version: 2 | 3
  /** 原始 cwd —— slug 编码有损,真实路径存在记录里。 */
  cwd: string
  createdAt: string
  updatedAt: string
  messages: Message[]
  totalUsage: Usage
  /** v3 起;v2 文件缺省为 []。 */
  checkpoints?: SessionCheckpoint[]
}

/**
 * 压缩联动:applyCompaction 把 messages[0..cut) 折叠成 1 条摘要后,检查点下标
 * 整体漂移 —— 折叠区间内的检查点失效删除,保留区间的重映射(− cut + 1 条摘要占位)。
 */
export function remapCheckpoints(
  checkpoints: SessionCheckpoint[],
  cutIndex: number,
): SessionCheckpoint[] {
  return checkpoints
    .filter((c) => c.messageIndex >= cutIndex)
    .map((c) => ({ ...c, messageIndex: c.messageIndex - cutIndex + 1 }))
}

/** /resume 列表项(轻量元数据,不含完整 messages)。 */
export interface SessionMeta {
  id: string
  createdAt: string
  updatedAt: string
  /** 首条用户消息截断预览(40 字 + …),列表里认会话用。 */
  firstUserText: string
  messageCount: number
}

/** 会话 id:时间可排序 + 4 位随机防同秒碰撞。进程生命周期内不变(/clear 才换新)。 */
export function newSessionId(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`
}

/** id 必须长得像 newSessionId 产物 —— 顺带挡掉路径穿越(.. / 斜杠都不匹配)。 */
function safeSessionId(id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`无效的会话 id:"${id}"`)
  return id
}

function autoDir(cwd: string): string {
  return join(sessionsRoot(), 'auto', cwdSlug(cwd))
}

/**
 * 每回合提交后调用的自动保存。空会话不落盘(避免开了就关的空壳文件);
 * 同一 id 覆写同一文件 —— 一条会话一个文件,updatedAt 随写刷新。
 * 调用方 fire-and-forget 并自行吞错:autosave 失败不能打断对话。
 */
export async function autosaveSession(
  id: string,
  cwd: string,
  conv: Conversation,
  createdAt: string,
  checkpoints: SessionCheckpoint[] = [],
): Promise<void> {
  if (conv.length === 0) return
  const dir = autoDir(cwd)
  await mkdir(dir, { recursive: true })
  const snapshot = conv.toJSON()
  const record: SessionRecord = {
    version: 3,
    cwd,
    createdAt,
    updatedAt: new Date().toISOString(),
    messages: snapshot.messages,
    totalUsage: snapshot.totalUsage,
    checkpoints,
  }
  await writeFile(join(dir, `${safeSessionId(id)}.json`), JSON.stringify(record, null, 2), 'utf8')
}

/** 从消息列表提取首条用户文本并截断,供列表预览。 */
function firstUserPreview(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const block = m.content.find((b) => b.type === 'text')
    if (block && block.type === 'text') {
      const text = block.text.replace(/\s+/g, ' ').trim()
      return text.length > 40 ? text.slice(0, 40) + '…' : text
    }
  }
  return '(无用户消息)'
}

/**
 * 列出某 cwd 的自动会话,updatedAt 最新在前。损坏的文件直接跳过 ——
 * 一个坏文件不能毁掉 --continue/--resume。
 */
export async function listAutoSessions(cwd: string, limit = 10): Promise<SessionMeta[]> {
  const dir = autoDir(cwd)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return [] // 目录不存在 = 还没有会话
  }
  const metas: SessionMeta[] = []
  for (const f of files) {
    try {
      const record = JSON.parse(await readFile(join(dir, f), 'utf8')) as SessionRecord
      if ((record.version !== 2 && record.version !== 3) || !Array.isArray(record.messages)) continue
      metas.push({
        id: f.slice(0, -'.json'.length),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        firstUserText: firstUserPreview(record.messages),
        messageCount: record.messages.length,
      })
    } catch {
      continue // 损坏文件:跳过
    }
  }
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return metas.slice(0, limit)
}

/** 载入指定自动会话。返回 Conversation 与续写所需的元数据(id 沿用 = 同一会话延续)。 */
export async function loadAutoSession(
  cwd: string,
  id: string,
): Promise<{ conversation: Conversation; id: string; createdAt: string; checkpoints: SessionCheckpoint[] }> {
  const path = join(autoDir(cwd), `${safeSessionId(id)}.json`)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(`找不到会话 "${id}"(目录 ${cwd})`)
  }
  const record = JSON.parse(raw) as SessionRecord
  if (record.version !== 2 && record.version !== 3) {
    throw new Error(`不支持的会话格式 version: ${String(record.version)}`)
  }
  const conversation = Conversation.fromJSON({
    version: 1,
    messages: record.messages,
    totalUsage: record.totalUsage,
  })
  // v2 无 checkpoints 字段 → 空;v3 原样带回(影子仓库在盘上,跨进程 hash 仍有效)。
  return { conversation, id, createdAt: record.createdAt, checkpoints: record.checkpoints ?? [] }
}
