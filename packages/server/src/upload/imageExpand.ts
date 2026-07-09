import type { Message } from '@zuse/core'
import type { UploadService } from './UploadService.js'

/** 直传路径:把每条消息里 route==='direct' 的 attachments 读盘展开成 image 块，插到 content 前，
 *  产出请求专用副本；route!=='direct'（如 'parsed'）跳过；读不出的图跳过。原消息不被 mutate。 */
export function makeExpandAttachments(upload: UploadService): (messages: Message[]) => Promise<Message[]> {
  return async (messages) => Promise.all(messages.map(async (m) => {
    const direct = (m.attachments ?? []).filter((a) => a.route === 'direct')
    if (direct.length === 0) return m
    const blocks: Message['content'] = []
    for (const a of direct) {
      try {
        const { data, mediaType } = await upload.readBase64(a.id)
        blocks.push({ type: 'image', source: { type: 'base64', mediaType, data } })
      } catch { /* 读不出就跳过这张，纯文本照发 */ }
    }
    return blocks.length ? { ...m, content: [...blocks, ...m.content] } : m
  }))
}
