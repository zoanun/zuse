import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Conversation, type ConversationSnapshot } from '@zuse/core'

/** 已保存会话的存放位置：~/.zuse/sessions/<name>.json */
const SESSIONS_DIR = join(homedir(), '.zuse', 'sessions')

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
  return join(SESSIONS_DIR, `${safeName(name)}.json`)
}

/** 序列化并写入一个会话。返回它写入的文件路径。 */
export async function saveConversation(name: string, conv: Conversation): Promise<string> {
  await mkdir(SESSIONS_DIR, { recursive: true })
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
