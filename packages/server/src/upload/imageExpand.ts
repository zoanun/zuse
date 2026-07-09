import type { Message } from '@zuse/core'
import type { UploadService } from './UploadService.js'

type Block = Message['content'][number]

/** 发送前物化附件（两条图片路径统一经此展开）：对每条消息的 attachments 构造前置块，插到
 *  content 前，产出请求专用副本（原消息不被 mutate）。
 *  - route==='direct'（视觉主模型直传）→ 每张读盘为一个 base64 image 块；读不出的图跳过。
 *  - route==='parsed'（非视觉解析兜底）→ 全部非空描述**合并成一个带编号标签的 text 块**，
 *    形如「[本条消息附带 N 张图片…] ▍图片1（name）\n<描述>\n\n▍图片2…」。多图时标签让模型能把
 *    每段描述对应到用户看到的第几张图（否则多段裸描述会被模型当成一张图而混淆/漏答）。
 *  无 attachments 的消息原样返回。账本/持久化的消息绝不含 base64，也不烘焙描述进文本。 */
export function makeExpandAttachments(upload: UploadService): (messages: Message[]) => Promise<Message[]> {
  return async (messages) => Promise.all(messages.map(async (m) => {
    const atts = m.attachments ?? []
    if (atts.length === 0) return m
    // direct：各张并行读盘成 image 块（读不出的跳过，不影响其它）。
    const imageBlocks = (await Promise.all(
      atts.filter((a) => a.route === 'direct').map((a) =>
        upload.readBase64(a.id)
          .then(({ data, mediaType }): Block => ({ type: 'image', source: { type: 'base64', mediaType, data } }))
          .catch((): Block | null => null),
      ),
    )).filter((b): b is Block => b !== null)
    // parsed：非空描述合并成单个带编号标签的 text 块，让模型能区分是第几张图。
    // 先 trim 一次成 {name, desc}、过滤掉空描述，避免在 filter 与 map 各 trim 一遍 + 非空断言。
    const parsed = atts
      .filter((a) => a.route === 'parsed')
      .map((a) => ({ name: a.name, desc: (a.description ?? '').trim() }))
      .filter((a) => a.desc !== '')
    const blocks: Block[] = [...imageBlocks]
    if (parsed.length > 0) {
      const multi = parsed.length > 1
      const header = `[本条消息附带 ${parsed.length} 张图片，以下是${multi ? '每张' : '其'}内容描述（由图像解析模型转述，非用户原话）：]\n\n`
      const body = parsed
        .map((a, i) => (multi ? `▍图片 ${i + 1}（${a.name}）\n${a.desc}` : a.desc))
        .join('\n\n')
      blocks.push({ type: 'text', text: header + body })
    }
    return blocks.length ? { ...m, content: [...blocks, ...m.content] } : m
  }))
}
