import { cpus } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Conversation } from './conversation.js'
import { ToolRegistry } from './tool.js'
import type { FileReadTracker } from './tool.js'
import { runAgent } from './agent.js'
import { createModelClient } from './model-client.js'
import type { ModelClient } from './model-client.js'
import { getProviderConfig } from './settings.js'
import type { ResolvedSettings, PermissionRequest, PermissionVerdict } from './types.js'

// ── Journal (Workflow Resume) ────────────────────────────────────────

interface JournalEntry {
  hash: string
  prompt: string
  opts?: Partial<AgentOpts>
  result: unknown
  tokens: number
}

export function generateRunId(): string {
  return `wf_${randomBytes(6).toString('hex')}`
}

export function computeAgentHash(prompt: string, opts?: AgentOpts): string {
  const key = {
    prompt,
    opts: opts
      ? { label: opts.label, model: opts.model, maxTurns: opts.maxTurns, schema: opts.schema, allowedTools: opts.allowedTools }
      : undefined,
  }
  return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16)
}

function readJournal(filePath: string): JournalEntry[] {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as JournalEntry)
  } catch {
    return []
  }
}

function appendJournal(filePath: string, entry: JournalEntry): void {
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8')
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_AGENTS = 100
const SUB_AGENT_MAX_TURNS = 10
const SUB_AGENT_SUFFIX = `\n\nYou are a sub-agent dispatched to execute a specific task. Your final text reply is the return value — it will be handed back to the caller, not shown to the user. Act immediately — do not output a plan or ask for confirmation. Use your tools to complete the task, then report the result. Be concise and structured. You are a leaf worker and CANNOT spawn further sub-agents. You also have no TodoWrite or ScheduleWakeup — those belong to the session that dispatched you; do not try to call them.`

export class Semaphore {
  private available: number
  private queue: Array<() => void> = []

  constructor(concurrency: number) {
    this.available = Math.max(1, concurrency)
  }

  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryAcquire = () => {
        if (this.available > 0) {
          this.available--
          resolve(() => {
            this.available++
            const next = this.queue.shift()
            if (next) next()
          })
        } else {
          this.queue.push(tryAcquire)
        }
      }
      tryAcquire()
    })
  }
}

export interface AgentOpts {
  label?: string
  allowedTools?: string[]
  model?: string
  maxTurns?: number
  /** JSON Schema — 子 Agent 被指示以 JSON 回复，返回值为解析后的对象。校验失败返回 null。 */
  schema?: Record<string, unknown>
}

export interface WorkflowContext {
  registry: ToolRegistry
  getClient: () => ModelClient
  settings: ResolvedSettings
  getSystemPrompt: () => string
  signal: AbortSignal
  cwd: string
  tracker: FileReadTracker
  sessionAllow?: string[]
  canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>
  concurrency?: number
  maxAgents?: number
  /** Token 预算(output tokens)。null = 不限。agent() 每次调用累加消耗,超预算抛错。 */
  tokenBudget?: number | null
  /** Resume from a previous run: load its journal and skip matching agent() calls. */
  resumeFromRunId?: string
  /** Override journal directory (for tests). Default: <cwd>/.zuse/workflow-journal/ */
  journalDir?: string
}

export function createWorkflow(ctx: WorkflowContext) {
  const concurrency = ctx.concurrency ?? Math.max(1, Math.min(8, cpus().length - 2))
  const sem = new Semaphore(concurrency)
  const maxAgents = ctx.maxAgents ?? DEFAULT_MAX_AGENTS
  let agentCount = 0
  let tokensSpent = 0
  const tokenBudget = ctx.tokenBudget ?? null

  const runId = generateRunId()
  const journalDir = ctx.journalDir ?? join(ctx.cwd, '.zuse', 'workflow-journal')
  const journalPath = join(journalDir, `${runId}.jsonl`)

  // Resume: load previous journal entries for sequential matching
  const previousEntries: JournalEntry[] = ctx.resumeFromRunId
    ? readJournal(join(journalDir, `${ctx.resumeFromRunId}.jsonl`))
    : []
  let journalIndex = 0
  let journalInvalidated = false

  const budget = {
    get total() { return tokenBudget },
    spent() { return tokensSpent },
    remaining() { return tokenBudget === null ? Infinity : Math.max(0, tokenBudget - tokensSpent) },
  }

  async function agent(prompt: string, opts?: AgentOpts): Promise<string | null> {
    if (agentCount >= maxAgents) {
      throw new Error(`Workflow agent limit reached (${maxAgents})`)
    }
    if (tokenBudget !== null && tokensSpent >= tokenBudget) {
      throw new Error(`Workflow token budget exhausted (${tokensSpent}/${tokenBudget})`)
    }

    const hash = computeAgentHash(prompt, opts)
    const seqIdx = journalIndex++

    // Resume cache: sequential match — Nth call matches Nth journal entry.
    // Once any entry mismatches, all subsequent entries are invalidated.
    const cached = previousEntries[seqIdx]
    if (!journalInvalidated && cached && cached.hash === hash) {
      agentCount++
      tokensSpent += cached.tokens
      // Persist to new journal for future resumes
      mkdirSync(journalDir, { recursive: true })
      appendJournal(journalPath, cached)
      return cached.result as string | null
    }

    // Mismatch or beyond journal: invalidate all subsequent entries
    if (cached && cached.hash !== hash) journalInvalidated = true

    agentCount++

    const release = await sem.acquire()
    try {
      let client: ModelClient
      if (typeof opts?.model === 'string' && opts.model !== '') {
        const slash = opts.model.indexOf('/')
        if (slash <= 0) return null
        const providerId = opts.model.slice(0, slash)
        const modelName = opts.model.slice(slash + 1)
        if (!modelName) return null
        try {
          const providerConfig = getProviderConfig(ctx.settings, providerId)
          client = createModelClient(providerConfig, modelName)
        } catch {
          return null
        }
      } else {
        client = ctx.getClient()
      }

      const childRegistry = new ToolRegistry()
      const whitelist = opts?.allowedTools
        ? new Set(opts.allowedTools.filter((t) => t !== 'Agent'))
        : null
      for (const tool of ctx.registry.list()) {
        // 与 agent-tool.ts 的 buildChildRegistry 保持同一套判据：会话级工具绑父会话 sink，
        // 子代理继承就会改到用户正在看的东西。本文件目前没有生产调用方，但**照样要改** ——
        // 留一份不一致的副本，等它哪天被接上，这个洞会以「只在 workflow 里复现」的形态回来。
        if (tool.sessionScoped) continue
        if (whitelist && !whitelist.has(tool.name)) continue
        childRegistry.register(tool)
      }

      const conversation = new Conversation()
      const effectivePrompt = opts?.schema
        ? `${prompt}\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(opts.schema, null, 2)}\n\nYour ENTIRE response must be a single valid JSON object matching the schema above. No markdown, no code fences, no explanation before or after. If you add anything besides the JSON, parsing will fail and you will need to retry.`
        : prompt
      let finalText = ''
      let resultTokens = 0
      for await (const event of runAgent({
        conversation,
        client,
        registry: childRegistry,
        userText: effectivePrompt,
        config: {
          model: client.getModel(),
          max_tokens: 16384,
          system: ctx.getSystemPrompt() + SUB_AGENT_SUFFIX,
        },
        cwd: ctx.cwd,
        signal: ctx.signal,
        maxTurns: opts?.maxTurns ?? SUB_AGENT_MAX_TURNS,
        tracker: ctx.tracker,
        settings: ctx.settings,
        sessionAllow: ctx.sessionAllow,
        canUseTool: ctx.canUseTool,
      })) {
        if (event.type === 'text-delta') {
          finalText += event.text
        } else if (event.type === 'message-stop') {
          resultTokens += event.usage.output_tokens
          tokensSpent += event.usage.output_tokens
        }
      }

      let result: string | null = null
      if (!finalText) {
        result = null
      } else if (opts?.schema) {
        try {
          const cleaned = finalText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
          result = JSON.parse(cleaned)
        } catch {
          result = null
        }
      } else {
        result = finalText
      }

      // Persist to journal for future resumes
      mkdirSync(journalDir, { recursive: true })
      appendJournal(journalPath, { hash, prompt, opts, result, tokens: resultTokens })

      return result
    } catch {
      return null
    } finally {
      release()
    }
  }

  async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> {
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk()
        } catch {
          return null
        }
      }),
    )
  }

  async function pipeline<T>(
    items: T[],
    ...stages: Array<(input: unknown, originalItem: T, index: number) => Promise<unknown>>
  ): Promise<unknown[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let current: unknown = item
        for (const stage of stages) {
          try {
            current = await stage(current, item, index)
          } catch {
            return null
          }
        }
        return current
      }),
    )
  }

  return { agent, parallel, pipeline, budget, runId }
}
