/**
 * submit() 给模型的 user 文本加 `[YYYY-MM-DD HH:MM +HH:MM] ` 前缀（本地时间 + 显式时区偏移）。
 * 需要还原原始提问的消费者 (projectMessages 显示、retry 重发、S4 历史搜索) 都经这一份定义剥除，
 * 格式只活在一处。时间用 daemon 所在机器的**系统本地时区**（对本地单用户守护进程即用户时区），
 * 不再用 UTC（旧版 toISOString 会比 +8 用户的墙钟慢 8 小时）；偏移显式写出，模型无歧义。
 */
// 偏移段设为可选：旧账本里的戳是无偏移的 `[YYYY-MM-DD HH:MM] `，必须仍能被剥除（向后兼容）。
export const USER_STAMP_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: [+-]\d{2}:\d{2})?\] /
export function stripUserStamp(text: string): string {
  return text.replace(USER_STAMP_RE, '')
}

/** Producer for the stamp stripUserStamp/USER_STAMP_RE remove — keeps the format in ONE place so
 *  producer and matcher can't drift. Local wall-clock + numeric offset, e.g. "[2026-07-10 20:58 +08:00] hi". */
export function applyUserStamp(text: string, at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const offMin = -at.getTimezoneOffset() // +480 for UTC+8 (getTimezoneOffset returns minutes BEHIND UTC)
  const sign = offMin >= 0 ? '+' : '-'
  const off = `${sign}${p(Math.floor(Math.abs(offMin) / 60))}:${p(Math.abs(offMin) % 60)}`
  const local = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`
  return `[${local} ${off}] ${text}`
}
