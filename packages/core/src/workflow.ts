import { cpus } from 'node:os'
import { Conversation } from './conversation.js'
import { ToolRegistry } from './tool.js'
import type { FileReadTracker } from './tool.js'
import { runAgent } from './agent.js'
import { createModelClient } from './model-client.js'
import type { ModelClient } from './model-client.js'
import { getProviderConfig } from './settings.js'
import type { ResolvedSettings, PermissionRequest, PermissionVerdict } from './types.js'

const DEFAULT_MAX_AGENTS = 100
const SUB_AGENT_MAX_TURNS = 10
const SUB_AGENT_SUFFIX = `\n\nYou are a sub-agent dispatched to execute a specific task. Your final text reply is the return value — it will be handed back to the caller, not shown to the user. Be concise and structured.`

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
}

export function createWorkflow(ctx: WorkflowContext) {
  const concurrency = ctx.concurrency ?? Math.max(1, Math.min(8, cpus().length - 2))
  const sem = new Semaphore(concurrency)
  const maxAgents = ctx.maxAgents ?? DEFAULT_MAX_AGENTS
  let agentCount = 0
  let tokensSpent = 0
  const tokenBudget = ctx.tokenBudget ?? null

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
        if (tool.name === 'Agent') continue
        if (whitelist && !whitelist.has(tool.name)) continue
        childRegistry.register(tool)
      }

      const conversation = new Conversation()
      const effectivePrompt = opts?.schema
        ? `${prompt}\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(opts.schema, null, 2)}\n\nOutput ONLY the JSON object, no markdown fences or extra text.`
        : prompt
      let finalText = ''
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
          tokensSpent += event.usage.output_tokens
        }
      }

      if (!finalText) return null
      if (opts?.schema) {
        try {
          const cleaned = finalText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
          return JSON.parse(cleaned)
        } catch {
          return null
        }
      }
      return finalText
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
    ...stages: Array<(input: any, originalItem: T, index: number) => Promise<any>>
  ): Promise<any[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let current: any = item
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

  return { agent, parallel, pipeline, budget }
}
