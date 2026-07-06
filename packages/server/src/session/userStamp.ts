/**
 * submit() 给模型的 user 文本加 `[YYYY-MM-DD HH:MM] ` 前缀。需要还原原始提问的消费者
 * (projectMessages 显示、retry 重发、S4 历史搜索) 都经这一份定义剥除，格式只活在一处。
 */
export const USER_STAMP_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /
export function stripUserStamp(text: string): string {
  return text.replace(USER_STAMP_RE, '')
}

/** Producer for the stamp stripUserStamp/USER_STAMP_RE remove — keeps the `[YYYY-MM-DD HH:MM] `
 *  format in ONE place so producer and matcher can't drift. Yields e.g. "[2026-07-06 12:34] hi". */
export function applyUserStamp(text: string, at: Date = new Date()): string {
  return `[${at.toISOString().slice(0, 16).replace('T', ' ')}] ${text}`
}
