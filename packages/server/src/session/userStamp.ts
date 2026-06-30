/**
 * submit() 给模型的 user 文本加 `[YYYY-MM-DD HH:MM] ` 前缀。需要还原原始提问的消费者
 * (projectMessages 显示、retry 重发、S4 历史搜索) 都经这一份定义剥除，格式只活在一处。
 */
export const USER_STAMP_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /
export function stripUserStamp(text: string): string {
  return text.replace(USER_STAMP_RE, '')
}
