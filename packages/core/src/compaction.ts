import { Conversation } from './conversation.js'
import type { Message, ModelConfig } from './types.js'
import type { ModelClient } from './model-client.js'

/**
 * 上下文压缩(Phase 10B)—— keep recent + summarize middle。
 *
 * 把账本切成两段:摘要段(老历史,交模型生成结构化摘要)+ 保留段(最近
 * KEEP_RECENT_TURNS 个真实用户回合,逐字节保留)。压缩后账本 =
 * [user: 摘要] + 保留段。窗口占用判定不在这里 —— 调用方用上一回合实测的
 * input_tokens(含 cache 读)对照 provider 的 contextWindow。
 */

/** 压缩时保留的最近真实用户回合数。 */
export const KEEP_RECENT_TURNS = 2

/** 默认上下文窗口(provider 未配 contextWindow 时)。保守取 128k:宁可早压不可炸窗。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** 占用超过窗口的此比例即触发自动压缩。 */
export const COMPACTION_THRESHOLD = 0.8

/** 摘要调用的输出预算。 */
export const SUMMARY_MAX_TOKENS = 2_000

/** 摘要 prompt 里单条工具结果/入参的截断长度(老历史里的工具输出是压缩的主要肥肉)。 */
const TOOL_EXCERPT_CHARS = 400

/**
 * 真实用户回合的起点:role 为 user 且首块是 text。
 * tool_result 回填消息 role 也是 user,但它属于上一个回合的工具往返 ——
 * 在它上面切会把 assistant 的 tool_use 与配对的 tool_result 劈开,
 * 两家协议都会直接拒掉下一次请求。
 */
function isUserTurnStart(m: Message): boolean {
  return m.role === 'user' && m.content[0]?.type === 'text'
}

/**
 * 找压缩切点:返回保留段起点的下标(该位置起到末尾的 keepTurns 个真实用户回合
 * 全部保留)。摘要段为空(没东西可压)时返回 null。
 */
export function findCompactionCut(messages: Message[], keepTurns = KEEP_RECENT_TURNS): number | null {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isUserTurnStart(messages[i]!)) continue
    seen++
    if (seen === keepTurns) {
      return i > 0 ? i : null
    }
  }
  return null
}

/** 单块内容渲染成摘要 transcript 的一行(工具块给出名字与截断片段,不灌全文)。 */
function renderBlock(b: Message['content'][number]): string {
  if (b.type === 'text') return b.text
  if (b.type === 'tool_use') {
    const input = JSON.stringify(b.input ?? {})
    return `[调用工具 ${b.name}(${input.length > TOOL_EXCERPT_CHARS ? input.slice(0, TOOL_EXCERPT_CHARS) + '…' : input})]`
  }
  const excerpt =
    b.content.length > TOOL_EXCERPT_CHARS ? b.content.slice(0, TOOL_EXCERPT_CHARS) + '…' : b.content
  return `[工具结果${b.is_error ? '(失败)' : ''}: ${excerpt}]`
}

/** 把摘要段渲染成 transcript 并附摘要指令,交模型生成结构化摘要。 */
export function buildSummaryPrompt(messages: Message[]): string {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.map(renderBlock).join('\n')}`)
    .join('\n\n')
  return (
    '下面是一段对话的较早部分。请把它压缩成一份后续对话可以依赖的结构化摘要,' +
    '用中文,涵盖:\n' +
    '1. 任务目标与当前状态\n' +
    '2. 关键决策与理由\n' +
    '3. 改动过的文件清单\n' +
    '4. 未完成事项\n' +
    '5. 用户明确提出的约束\n' +
    '只输出摘要本身,不要前言后语。\n\n' +
    '<对话>\n' +
    transcript +
    '\n</对话>'
  )
}

/**
 * 用摘要替换切点之前的历史,返回新账本。保留段逐字节不动;
 * totalUsage 原样带过去 —— 它是成本账,不是窗口账。
 */
export function applyCompaction(conv: Conversation, summaryText: string, cutIndex: number): Conversation {
  const messages = conv.getMessages()
  const summaryMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text: `[之前对话的摘要]\n${summaryText}` }],
  }
  return Conversation.fromJSON({
    version: 1,
    messages: [summaryMessage, ...messages.slice(cutIndex)],
    totalUsage: conv.totalUsage,
  })
}

/**
 * 调当前模型生成摘要(单独请求:无工具、收紧 max_tokens)。任何失败都抛出 ——
 * 调用方保持原账本不动,绝不半压。
 */
export async function summarizeForCompaction(
  client: ModelClient,
  toSummarize: Message[],
  config: Pick<ModelConfig, 'model' | 'max_tokens'>,
  signal?: AbortSignal,
): Promise<string> {
  const request: Message[] = [
    { role: 'user', content: [{ type: 'text', text: buildSummaryPrompt(toSummarize) }] },
  ]
  let text = ''
  const events = client.sendMessages(
    request,
    { model: config.model, max_tokens: Math.min(config.max_tokens, SUMMARY_MAX_TOKENS) },
    undefined,
    signal,
  )
  for await (const e of events) {
    if (e.type === 'text-delta') text += e.text
    else if (e.type === 'error') throw new Error(`压缩摘要失败:${e.message}`)
  }
  if (text.trim() === '') throw new Error('压缩摘要失败:模型未返回内容')
  return text
}
