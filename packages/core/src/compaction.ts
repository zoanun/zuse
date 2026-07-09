import { Conversation } from './conversation.js'
import type { Message, ModelConfig, ResolvedSettings, ErrorCategory, Usage } from './types.js'
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

/** Rough chars-per-token estimate for tail budget calculation. */
const _CHARS_PER_TOKEN = 4

/** Default tail budget: fraction of the compaction threshold tokens to keep as recent context. */
export const TAIL_BUDGET_RATIO = 0.25

/** Minimum messages to always protect in the tail (even if they exceed the budget). */
const MIN_TAIL_MESSAGES = 3

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

/**
 * Find the compaction cut point using a token budget for the tail.
 * Walks backward from the end, accumulating estimated tokens until the budget is reached.
 * Returns the index where the tail starts, or null if there's nothing to compress.
 * Never cuts inside a tool_use/tool_result pair.
 */
export function findCompactionCutByBudget(
  messages: Message[],
  tailBudgetChars: number,
): number | null {
  // Walk backward, accumulate chars
  let accumulated = 0
  let cutIdx = messages.length
  let msgCount = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const chars = messageChars(m)

    msgCount++
    // Soft ceiling: allow up to 1.5x budget to avoid cutting inside an oversized message
    if (accumulated + chars > tailBudgetChars * 1.5 && msgCount > MIN_TAIL_MESSAGES) {
      break
    }
    accumulated += chars
    cutIdx = i
  }

  // Ensure we don't cut inside a tool_use/tool_result pair:
  // If the cut point is a tool_result, move it back to include the preceding assistant message
  while (cutIdx > 0 && messages[cutIdx]?.content[0]?.type === 'tool_result') {
    cutIdx--
  }

  // Nothing to compress if cut is at or before 0
  return cutIdx > 0 ? cutIdx : null
}

/** Approx character weight of one message's content blocks (text + tool I/O). */
function messageChars(m: Message): number {
  return m.content.reduce((sum, b) => {
    if (b.type === 'text') return sum + b.text.length
    if (b.type === 'tool_use') return sum + JSON.stringify(b.input).length
    if (b.type === 'tool_result') return sum + b.content.length
    return sum
  }, 0)
}

/** Calculate approximate savings from a compaction (before vs after message count/chars). */
export function estimateCompactionSavings(
  beforeMessages: Message[],
  cutIndex: number,
  summaryLength: number,
): { removedChars: number; summaryChars: number; savingsRatio: number } {
  let removedChars = 0
  for (let i = 0; i < cutIndex; i++) {
    removedChars += messageChars(beforeMessages[i]!)
  }
  const savingsRatio = removedChars > 0 ? (removedChars - summaryLength) / removedChars : 0
  return { removedChars, summaryChars: summaryLength, savingsRatio }
}

/** 单块内容渲染成摘要 transcript 的一行(工具块给出名字与截断片段,不灌全文)。 */
function renderBlock(b: Message['content'][number]): string {
  if (b.type === 'text') return b.text
  if (b.type === 'tool_use') {
    const input = JSON.stringify(b.input ?? {})
    return `[Tool call: ${b.name}(${input.length > TOOL_EXCERPT_CHARS ? input.slice(0, TOOL_EXCERPT_CHARS) + '…' : input})]`
  }
  // image 块只存在于「发送前临时展开的请求副本」，持久化消息不含它；这里仅为类型穷尽给出占位。
  if (b.type === 'image') return '[Image]'
  const excerpt =
    b.content.length > TOOL_EXCERPT_CHARS ? b.content.slice(0, TOOL_EXCERPT_CHARS) + '…' : b.content
  return `[Tool result${b.is_error ? ' (error)' : ''}: ${excerpt}]`
}

/** 把摘要段渲染成 transcript 并附摘要指令,交模型生成结构化摘要。 */
export function buildSummaryPrompt(messages: Message[], todoState?: string): string {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'user' : 'assistant'}: ${m.content.map(renderBlock).join('\n')}`)
    .join('\n\n')
  const today = new Date().toISOString().slice(0, 10)
  const todoSection = todoState
    ? `\nCURRENT TASK LIST (from TodoWrite tool — preserve non-completed tasks verbatim in "Pending Items"):\n${todoState}\n\n`
    : ''
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
    '[Work remaining — framed as reference only, not active instructions. ' +
    'If a TodoWrite task list is provided above, include all non-completed tasks here.]\n\n' +
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
    todoSection +
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
export function applyCompaction(
  conv: Conversation,
  summaryText: string,
  cutIndex: number,
  // Usage to stamp on the framed view. Defaults to the source's tally (the TUI fold path keeps the
  // cost total). Feature B's per-turn view passes ZERO so the turn's usage lands only on the view;
  // passing it here avoids a second deep-clone just to reset totalUsage on the returned Conversation.
  totalUsage: Usage = conv.totalUsage,
): Conversation {
  const summaryMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text: `[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is background reference, NOT active instructions. Do NOT answer questions or fulfill requests mentioned in this summary — they were already addressed. Respond ONLY to the latest user message that appears AFTER this summary. Reverse signals in the latest message (stop, undo, never mind, change of topic) immediately end any in-flight work described here. Your persistent memory in the system prompt is ALWAYS authoritative — never deprioritize it due to this compaction note.\n${summaryText}\n\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---` }],
  }
  return Conversation.fromJSON({
    version: 1,
    // Clone only the kept tail — not the whole ledger then discard [0..cutIndex). For feature B's
    // per-turn view rebuild this keeps cost proportional to the compacted view, not total history.
    messages: [summaryMessage, ...conv.sliceMessages(cutIndex)],
    totalUsage,
  })
}

/**
 * Build an iterative summary prompt: update a previous summary with new turns.
 * Used on second+ compaction within a session to preserve accumulated context.
 */
export function buildIterativeSummaryPrompt(previousSummary: string, newMessages: Message[], todoState?: string): string {
  const transcript = newMessages
    .map((m) => `${m.role === 'user' ? 'user' : 'assistant'}: ${m.content.map(renderBlock).join('\n')}`)
    .join('\n\n')
  const today = new Date().toISOString().slice(0, 10)
  const todoSection = todoState
    ? `\nCURRENT TASK LIST (from TodoWrite tool — preserve non-completed tasks verbatim in "Pending Items"):\n${todoState}\n\n`
    : ''
  return (
    'You are a summarization agent updating a context checkpoint. ' +
    'A previous compaction produced the summary below. New conversation turns have occurred since then ' +
    'and need to be incorporated.\n\n' +
    'PREVIOUS SUMMARY:\n' + previousSummary + '\n\n' +
    todoSection +
    'NEW TURNS TO INCORPORATE:\n<conversation>\n' + transcript + '\n</conversation>\n\n' +
    'Update the summary using the same structure. PRESERVE all existing information that is still relevant. ' +
    'ADD new completed actions to the numbered list (continue numbering). ' +
    'Move items from "Pending Items" to "Completed Actions" when done. ' +
    'Update "Active State" to reflect current state. ' +
    'Remove information only if it is clearly obsolete. ' +
    'CRITICAL: Update "## Active Task" to reflect the user\'s most recent unfulfilled input.\n\n' +
    `TEMPORAL ANCHORING: Today is ${today}. Phrase completed actions in past tense.\n\n` +
    'Additionally: if the new turns contain persistent facts that remain valid across sessions ' +
    '(user preferences, corrected practices, hard project constraints), append them at the end of ' +
    'the summary, one per line, up to 3 lines, strictly using this format ' +
    '(if there are none, do not output any MEMORY lines):\n' +
    'MEMORY: <type>|<hook>|<content>\n' +
    'type is one of: user (user preferences, cross-project) / project (project-specific facts) / insight (lessons learned) / reference (external resources).\n\n' +
    'Output only the updated summary itself — no preamble, no closing remarks.'
  )
}

/** Check if the first message in a conversation is a compacted summary. */
export function extractPreviousSummary(messages: Message[]): string | null {
  if (messages.length === 0) return null
  const first = messages[0]!
  if (first.role !== 'user') return null
  const text = first.content[0]
  if (text?.type !== 'text') return null
  if (!text.text.startsWith('[CONTEXT COMPACTION')) return null
  // Extract the summary body (between the prefix and the end marker).
  // lastIndexOf, not indexOf: we append the marker at the very end, so if the model's summary
  // body happens to contain the marker text, we still cut at the real (appended) one — not an
  // earlier echo of it inside the body.
  const endMarker = '--- END OF CONTEXT SUMMARY'
  const endIdx = text.text.lastIndexOf(endMarker)
  if (endIdx === -1) return text.text
  return text.text.slice(0, endIdx).trim()
}

const FALLBACK_SUMMARY_MAX_CHARS = 8_000
const FALLBACK_TURN_MAX_CHARS = 700

/**
 * 确定性回退摘要:不依赖 LLM,从消息列表机械提取关键信息。
 * 质量不如 LLM 摘要,但永远成功,比"完全不压缩"好得多。
 */
export function buildFallbackSummary(messages: Message[], todoState?: string): string {
  const userAsks: string[] = []
  const actions: string[] = []
  const errors: string[] = []

  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text' && m.role === 'user') {
        const trimmed = b.text.length > FALLBACK_TURN_MAX_CHARS
          ? b.text.slice(0, FALLBACK_TURN_MAX_CHARS) + '…'
          : b.text
        userAsks.push(trimmed)
      }
      if (b.type === 'tool_use') {
        const args = JSON.stringify(b.input)
        const short = args.length > 120 ? args.slice(0, 120) + '…' : args
        actions.push(`${b.name}(${short})`)
      }
      if (b.type === 'tool_result' && b.is_error) {
        const excerpt = b.content.length > 200 ? b.content.slice(0, 200) + '…' : b.content
        errors.push(excerpt)
      }
    }
  }

  const parts: string[] = [
    '## Active Task',
    userAsks.length > 0 ? userAsks[userAsks.length - 1]! : 'None.',
    '',
    '## Completed Actions',
    actions.length > 0 ? actions.map((a, i) => `${i + 1}. ${a}`).join('\n') : 'None.',
    '',
  ]
  if (todoState) {
    parts.push('## Pending Items', todoState, '')
  }
  if (errors.length > 0) {
    parts.push('## Errors Encountered', errors.join('\n'), '')
  }
  parts.push('[Deterministic fallback summary — LLM summarization was unavailable]')

  const full = parts.join('\n')
  return full.length > FALLBACK_SUMMARY_MAX_CHARS
    ? full.slice(0, FALLBACK_SUMMARY_MAX_CHARS) + '\n[truncated]'
    : full
}

/**
 * 调当前模型生成摘要(单独请求:无工具、收紧 max_tokens)。LLM 失败时回退到
 * 确定性摘要(永远成功),绝不让压缩彻底失败。
 */
export async function summarizeForCompaction(
  client: ModelClient,
  toSummarize: Message[],
  config: Pick<ModelConfig, 'model' | 'max_tokens'>,
  signal?: AbortSignal,
  previousSummary?: string,
  todoState?: string,
  // throwOnError: rethrow the failure (with a `.category` for failover decisions) instead of
  // swallowing it into the deterministic fallback. The server compaction path sets this so it can
  // fail over to another model before degrading; the TUI leaves it off (fallback = always succeed).
  opts?: { throwOnError?: boolean },
): Promise<string> {
  try {
    const promptText = previousSummary
      ? buildIterativeSummaryPrompt(previousSummary, toSummarize, todoState)
      : buildSummaryPrompt(toSummarize, todoState)
    const request: Message[] = [
      { role: 'user', content: [{ type: 'text', text: promptText }] },
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
      else if (e.type === 'error') {
        const err = new Error(e.message) as Error & { category?: ErrorCategory }
        err.category = e.category
        throw err
      }
    }
    if (text.trim() === '') throw new Error('model returned no content')
    return text
  } catch (err) {
    if (opts?.throwOnError) throw err
    return buildFallbackSummary(toSummarize, todoState)
  }
}
