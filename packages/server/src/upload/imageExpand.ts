import type { Message } from '@zuse/core'
import type { UploadService } from './UploadService.js'

/** 发送前物化附件（两条图片路径统一经此展开）：对每条消息的 attachments 依序构造前置块，插到
 *  content 前，产出请求专用副本（原消息不被 mutate）。
 *  - route==='direct'（视觉主模型直传）→ 读盘为 base64 image 块；读不出的图跳过。
 *  - route==='parsed'（非视觉解析兜底）→ 描述非空则为一个 text 块（内容=模型看到的转述）；空描述跳过。
 *  无 attachments 的消息原样返回。账本/持久化的消息绝不含 base64，也不烘焙描述进文本。 */
export function makeExpandAttachments(upload: UploadService): (messages: Message[]) => Promise<Message[]> {
  return async (messages) => Promise.all(messages.map(async (m) => {
    const atts = m.attachments ?? []
    if (atts.length === 0) return m
    // 单消息内多附件并行物化；某项产出 null（direct 读不出 / parsed 空描述）被过滤掉，不影响其它。
    const blocks = (await Promise.all(atts.map(async (a): Promise<Message['content'][number] | null> => {
      if (a.route === 'direct') {
        return upload.readBase64(a.id)
          .then(({ data, mediaType }): Message['content'][number] => ({ type: 'image', source: { type: 'base64', mediaType, data } }))
          .catch(() => null)
      }
      if (a.route === 'parsed') {
        return a.description && a.description.trim() ? { type: 'text', text: a.description } : null
      }
      return null
    }))).filter((b): b is Message['content'][number] => b !== null)
    return blocks.length ? { ...m, content: [...blocks, ...m.content] } : m
  }))
}
