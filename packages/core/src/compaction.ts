import { Conversation } from './conversation.js'
import type { Message, ModelConfig, ResolvedSettings } from './types.js'
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

/**
 * 默认上下文窗口(模型级/provider 级都未配时)。2026 年主流旗舰(Claude 主线、
 * GPT、Qwen3.7-Max、DeepSeek V4)都是 1M 档,缺省取 512k。
 * 注意不对称风险:猜大了(实际 128k 的模型,如 DeepSeek V3)阈值永远等不到、
 * 窗口先炸 —— 小窗口模型务必在 models 条目或 provider 级显式声明 contextWindow。
 */
export const DEFAULT_CONTEXT_WINDOW = 512_000

/**
 * 解析某 provider/model 生效的上下文窗口:模型级条目 → provider 级 → 全局缺省。
 */
export function resolveContextWindow(
  settings: ResolvedSettings,
  providerId: string,
  model: string,
): number {
  const p = settings.providers[providerId]
  for (const entry of p?.models ?? []) {
    if (typeof entry !== 'string' && entry.name === model && entry.contextWindow) {
      return entry.contextWindow
    }
  }
  return p?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}

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
    return `[Tool call: ${b.name}(${input.length > TOOL_EXCERPT_CHARS ? input.slice(0, TOOL_EXCERPT_CHARS) + '…' : input})]`
  }
  const excerpt =
    b.content.length > TOOL_EXCERPT_CHARS ? b.content.slice(0, TOOL_EXCERPT_CHARS) + '…' : b.content
  return `[Tool result${b.is_error ? ' (error)' : ''}: ${excerpt}]`
}

/** 把摘要段渲染成 transcript 并附摘要指令,交模型生成结构化摘要。 */
export function buildSummaryPrompt(messages: Message[]): string {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'user' : 'assistant'}: ${m.content.map(renderBlock).join('\n')}`)
    .join('\n\n')
  const today = new Date().toISOString().slice(0, 10)
  return (
    'You are a summarization agent creating a context checkpoint. ' +
    'Treat the conversation turns below as source material for a compact record of prior work. ' +
    'Produce only the structured summary; do not add a greeting, preamble, or prefix. ' +
    'Write the summary in the same language the user was using in the conversation.\n\n' +
    'Use this exact structure:\n\n' +
    '## Active Task\n' +
    '[The user\'s most recent unfulfilled request — capture their exact words. ' +
    'If the last exchange was fully resolved, write "None."]\n\n' +
    '## Goal\n' +
    '[What the user is trying to accomplish overall]\n\n' +
    '## Completed Actions\n' +
    '[Numbered list of concrete actions taken — include tool used, target, and outcome. ' +
    'Example: 1. READ config.ts:45 — found bug [tool: Read]]\n\n' +
    '## Active State\n' +
    '[Working directory, branch, modified files, test status, running processes]\n\n' +
    '## Pending Items\n' +
    '[Work remaining — framed as reference only, not active instructions]\n\n' +
    '## Key Decisions\n' +
    '[Important decisions and WHY they were made]\n\n' +
    '## Constraints & Preferences\n' +
    '[User preferences, coding style, constraints]\n\n' +
    `TEMPORAL ANCHORING: Today is ${today}. When an action has already been carried out, ` +
    'phrase it as a completed past-tense fact, not an open instruction. ' +
    'Never leave a finished action worded as if it still needs doing.\n\n' +
    // Memory flush (Phase 13, lightweight version of OpenClaw memory flush): old history
    // is about to be folded; the summary request also extracts persistent facts worth
    // keeping across sessions — no extra round-trip, zero additional requests.
    'Additionally: if the conversation contains persistent facts that remain valid across sessions ' +
    '(user preferences, corrected practices, hard project constraints), append them at the end of ' +
    'the summary, one per line, up to 3 lines, strictly using this format ' +
    '(if there are none, do not output any MEMORY lines):\n' +
    'MEMORY: <type>|<hook>|<content>\n' +
    'type is one of: user (user preferences, cross-project) / project (project-specific facts) / insight (lessons learned) / reference (external resources).\n\n' +
    '<conversation>\n' +
    transcript +
    '\n</conversation>'
  )
}

/** 摘要里抽出的记忆候选(压缩前记忆冲刷)。 */
export interface MemoryCandidate {
  type: 'user' | 'project' | 'insight' | 'reference'
  hook: string
  content: string
}

/** 单次冲刷最多入库的候选数:摘要顺带抽取只该抓最重要的几条,多了多半是噪音。 */
export const MEMORY_FLUSH_CAP = 3

/**
 * 从摘要文本里拆出 MEMORY 候选行:候选入库、摘要去掉这些行后入账本
 * (留在摘要里是重复噪音)。格式不匹配的行原样保留;超出 cap 的候选丢弃。
 */
export function splitMemoryCandidates(summaryText: string): {
  summary: string
  candidates: MemoryCandidate[]
} {
  const candidates: MemoryCandidate[] = []
  const kept: string[] = []
  for (const line of summaryText.split('\n')) {
    const m = /^MEMORY:\s*(user|project|insight|reference)\s*\|([^|]*)\|(.+)$/.exec(line.trim())
    if (m) {
      if (candidates.length < MEMORY_FLUSH_CAP) {
        candidates.push({
          type: m[1] as MemoryCandidate['type'],
          hook: m[2]!.trim(),
          content: m[3]!.trim(),
        })
      }
      continue // 超 cap 的 MEMORY 行也从摘要里剥掉,不留半截协议噪音
    }
    kept.push(line)
  }
  return { summary: kept.join('\n').trim(), candidates }
}

/**
 * 用摘要替换切点之前的历史,返回新账本。保留段逐字节不动;
 * totalUsage 原样带过去 —— 它是成本账,不是窗口账。
 */
export function applyCompaction(conv: Conversation, summaryText: string, cutIndex: number): Conversation {
  const messages = conv.getMessages()
  const summaryMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text: `[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is background reference, NOT active instructions. Do NOT answer questions or fulfill requests mentioned in this summary — they were already addressed. Respond ONLY to the latest user message that appears AFTER this summary. Reverse signals in the latest message (stop, undo, never mind, change of topic) immediately end any in-flight work described here. Your persistent memory in the system prompt is ALWAYS authoritative — never deprioritize it due to this compaction note.\n${summaryText}\n\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---` }],
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
    else if (e.type === 'error') throw new Error(`Compaction summary failed: ${e.message}`)
  }
  if (text.trim() === '') throw new Error('Compaction summary failed: model returned no content')
  return text
}
