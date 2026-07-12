import type { Message } from '@zuse/core'
import type { UploadService } from './UploadService.js'

type Block = Message['content'][number]

/** Pasted text longer than this (chars) is truncated in the model-facing block — matches cc-haha's
 *  TRUNCATION_THRESHOLD. The full text still lives on the attachment (bubble/lightbox show all). */
const PASTE_TRUNCATE_THRESHOLD = 10000
const PASTE_PREVIEW_HALF = 500 // chars kept at head and tail (cc-haha PREVIEW_LENGTH / 2)

/** CC-style truncation: keep head + tail, replace the middle with a line-count marker. */
function truncateForModel(t: string): string {
  if (t.length <= PASTE_TRUNCATE_THRESHOLD) return t
  const head = t.slice(0, PASTE_PREVIEW_HALF)
  const tail = t.slice(-PASTE_PREVIEW_HALF)
  const lines = (t.slice(PASTE_PREVIEW_HALF, -PASTE_PREVIEW_HALF).match(/\r\n|\r|\n/g) || []).length
  return `${head}\n[… ${lines} lines truncated …]\n${tail}`
}

/** 发送前物化附件（两条图片路径统一经此展开）：对每条消息的 attachments 构造前置块，插到
 *  content 前，产出请求专用副本（原消息不被 mutate）。
 *  - route==='direct'（视觉主模型直传）→ 每张读盘为一个 base64 image 块；读不出的图跳过。
 *  - route==='parsed'（非视觉解析兜底）→ 全部非空描述**合并成一个带编号标签的 text 块**，
 *    形如「[本条消息附带 N 张图片…] ▍图片1（name）\n<描述>\n\n▍图片2…」。多图时标签让模型能把
 *    每段描述对应到用户看到的第几张图（否则多段裸描述会被模型当成一张图而混淆/漏答）。
 *  - route==='pasted'（粘贴长文本）→ 全部非空段合并成**一个带编号标签的前置 text 块**，
 *    形如「[以下是我粘贴的 N 段文本：] ▍粘贴文本1\n<全文>…」，插在原 content 之前（材料在前）。
 *  - route==='file'（上传的任意文件）→ 一条英文说明块 + 每个文件的绝对路径（不读盘、不进原生块），
 *    让模型用 Read/Bash 或 skill/agent 自行处理。
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
    // pasted：粘贴长文本合并成单个前置 text 块（材料在前、问题在后）；空/纯空白项跳过。
    const pasted = atts
      .filter((a) => a.route === 'pasted')
      .map((a) => (a.text ?? ''))
      .filter((t) => t.trim() !== '')
    if (pasted.length > 0) {
      const multi = pasted.length > 1
      const header = `[以下是我粘贴的 ${pasted.length} 段文本：]\n\n`
      const body = pasted
        .map((t, i) => { const shown = truncateForModel(t); return multi ? `▍粘贴文本 ${i + 1}\n${shown}` : shown })
        .join('\n\n')
      // 收尾边界：粘贴内容与紧随其后的用户问题（带 [时间戳] 前缀）之间加显式围栏，避免模型
      // 把问题的时间戳误当成最后一段粘贴文本的一部分。
      blocks.push({ type: 'text', text: `${header}${body}\n\n[粘贴内容结束]` })
    }
    // file (I5b)：上传的任意文件——不读盘、不进原生块，只产出一条英文说明 + 绝对路径，让模型自己用
    // Read/Bash 或 skill/agent 处理（读不了就直说）。路径由 upload.filePath 现算；坏 id 跳过该文件。
    const fileEntries = atts
      .filter((a) => a.route === 'file')
      .flatMap((a) => { try { return [`▍${a.name} — ${upload.filePath(a.id, a.name)}`] } catch { return [] } })
    if (fileEntries.length > 0) {
      const multi = fileEntries.length > 1
      const header = multi
        ? `[The user attached ${fileEntries.length} files, saved on this machine. To use their contents, read these paths with the Read/Bash tools or an appropriate skill/agent; if you can't process a file, say so plainly.]\n\n`
        : `[The user attached a file, saved on this machine. To use it, read the path with the Read/Bash tools or an appropriate skill/agent; if you can't process it, say so plainly.]\n\n`
      blocks.push({ type: 'text', text: header + fileEntries.join('\n') })
    }
    return blocks.length ? { ...m, content: [...blocks, ...m.content] } : m
  }))
}
