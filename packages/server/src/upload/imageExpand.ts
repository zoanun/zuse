import type { Message } from '@zuse/core'
import type { UploadService } from './UploadService.js'

/** 直传路径:把每条消息里 route==='direct' 的 attachments 读盘展开成 image 块，插到 content 前，
 *  产出请求专用副本；route!=='direct'（如 'parsed'）跳过；读不出的图跳过。原消息不被 mutate。 */
export function makeExpandAttachments(upload: UploadService): (messages: Message[]) => Promise<Message[]> {
  return async (messages) => Promise.all(messages.map(async (m) => {
    const direct = (m.attachments ?? []).filter((a) => a.route === 'direct')
    if (direct.length === 0) return m
    // 单消息内多图并行读盘；某张读不出返回 null 被过滤掉（纯文本照发），不影响其它。
    const blocks = (await Promise.all(direct.map((a) =>
      upload.readBase64(a.id)
        .then(({ data, mediaType }): Message['content'][number] => ({ type: 'image', source: { type: 'base64', mediaType, data } }))
        .catch(() => null),
    ))).filter((b): b is Message['content'][number] => b !== null)
    return blocks.length ? { ...m, content: [...blocks, ...m.content] } : m
  }))
}
