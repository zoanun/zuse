import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Conversation, type ConversationSnapshot } from '@zuse/core'

/** Where saved sessions live: ~/.zuse/sessions/<name>.json */
const SESSIONS_DIR = join(homedir(), '.zuse', 'sessions')

/**
 * Reduce a user-supplied name to a single safe path segment. Strips anything
 * that could escape the sessions dir (slashes, "..") so /save and /load can't
 * be used for path traversal.
 */
export function safeName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9_.-]/g, '_')
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`Invalid session name: "${name}"`)
  }
  return cleaned
}

function sessionPath(name: string): string {
  return join(SESSIONS_DIR, `${safeName(name)}.json`)
}

/** Serialize and write a conversation. Returns the file path it wrote to. */
export async function saveConversation(name: string, conv: Conversation): Promise<string> {
  await mkdir(SESSIONS_DIR, { recursive: true })
  const path = sessionPath(name)
  await writeFile(path, JSON.stringify(conv.toJSON(), null, 2), 'utf8')
  return path
}

/** Read and deserialize a saved conversation. Throws if it doesn't exist or is corrupt. */
export async function loadConversation(name: string): Promise<Conversation> {
  const path = sessionPath(name)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(`No saved session named "${safeName(name)}"`)
  }
  const data = JSON.parse(raw) as ConversationSnapshot
  return Conversation.fromJSON(data)
}
