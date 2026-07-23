import type { ModelClient } from './model-client.js'
import type { Message } from './types.js'
import { genMsgId } from './conversation.js'

/** 标题最长字符数(与持久化层 deriveTitle 的截断保持一致)。 */
const TITLE_MAX_CHARS = 60
/** 标题生成的输出上限:标题很短,几十 token 足够,避免小模型啰嗦。 */
const TITLE_MAX_TOKENS = 48

/**
 * 用(通常是小)模型为会话生成一个简洁标题。单独一次请求:无工具、收紧 max_tokens。
 *
 * 失败(网络/额度/空回复)时返回 null —— 调用方据此回退到"截断第一句"等确定性方案,
 * 绝不让标题生成把主流程搞挂。语言跟随用户首条消息(模型自然处理)。
 *
 * @param firstUserText 会话首条用户消息的纯文本(已去掉 `[YYYY-MM-DD HH:MM] ` 前缀更佳)。
 */
export async function generateSessionTitle(
  client: ModelClient,
  model: string,
  firstUserText: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const trimmed = firstUserText.trim()
  if (!trimmed) return null
  try {
    const prompt =
      '为下面这段对话的开头生成一个简洁的标题。要求:不超过 6 个词;' +
      '用与原文相同的语言;只输出标题本身,不要引号、不要句末标点、不要"标题:"之类前缀。\n\n' +
      `开头消息:\n${trimmed.slice(0, 2000)}`
    const request: Message[] = [{ role: 'user', id: genMsgId(), content: [{ type: 'text', text: prompt }] }]
    let text = ''
    const events = client.sendMessages(request, { model, max_tokens: TITLE_MAX_TOKENS }, undefined, signal)
    for await (const e of events) {
      if (e.type === 'text-delta') text += e.text
      else if (e.type === 'error') throw new Error(e.message)
    }
    return sanitizeTitle(text)
  } catch {
    return null
  }
}

/**
 * 清洗模型输出为可用标题:去首尾空白/包裹引号、压平换行、去句末标点、截断到上限。
 * 清洗后为空则返回 null。
 */
function sanitizeTitle(raw: string): string | null {
  let t = raw.trim()
  // 一些小模型会把标题包在引号里,或自带 "标题:"/"Title:" 前缀。
  t = t.replace(/^(标题|title)\s*[:：]\s*/i, '')
  t = t.replace(/^["'“”『「]+|["'“”』」]+$/g, '')
  // 压平成单行(取首行非空内容),去掉句末标点。
  t = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? ''
  t = t.replace(/[。.!?！？；;,，\s]+$/u, '').trim()
  if (!t) return null
  return t.length > TITLE_MAX_CHARS ? t.slice(0, TITLE_MAX_CHARS) : t
}
