import { Conversation, ToolRegistry, runAgent, createModelClient, getProviderConfig } from '@zuse/core'
import type { ModelClient, Tool, ToolContext, ResolvedSettings, PermissionRequest, PermissionVerdict } from '@zuse/core'

const SUB_AGENT_MAX_TURNS = 10

const SUB_AGENT_SUFFIX = `\n\nYou are a sub-agent dispatched to execute a specific task. Your final text reply is the return value — it will be handed back to the caller, not shown to the user. Act immediately — do not output a plan or ask for confirmation. Use your tools to complete the task, then report the result. Be concise and structured. You are a leaf worker and CANNOT spawn further sub-agents.`

export interface AgentToolDeps {
  registry: ToolRegistry
  getClient: () => ModelClient
  settings: ResolvedSettings
  getSystemPrompt: () => string
  sessionAllow?: string[]
  canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>
  /** 后台 Agent 完成后的通知回调。传入 description + 结果文本。 */
  onBackground?: (description: string, result: string) => void
}

export function createAgentTool(deps: AgentToolDeps): Tool {
  return {
    name: 'Agent',
    description:
      'Launch a sub-agent to handle a complex or exploratory sub-task in an isolated context. ' +
      'The sub-agent has its own conversation and tool access, and returns its final text as the result. ' +
      'Use this when: (1) a task involves broad exploration that would pollute the main context, ' +
      '(2) a sub-task can run independently, or (3) you want to use a different model for a sub-task. ' +
      'Do NOT use for single-step work you can do in one or two tool calls — just do it directly. ' +
      'Do NOT delegate your entire task to a single sub-agent with no added value. ' +
      'The sub-agent cannot spawn further sub-agents. ' +
      'For background agents: do NOT poll or sleep for status — you will be notified automatically when they finish.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The sub-task description sent as input to the sub-agent. Be detailed enough for it to work independently.',
        },
        description: {
          type: 'string',
          description: 'Short label (3-10 words) for UI display.',
        },
        model: {
          type: 'string',
          description: 'Optional. Format: providerId/modelName. Use a cheaper model for simple sub-tasks.',
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. Restrict sub-agent to these tools only. Defaults to all tools.',
        },
        runInBackground: {
          type: 'boolean',
          description: 'Optional. Set true to run in background. Returns immediately; you will be notified on completion.',
        },
      },
      required: ['prompt', 'description'],
    },

    specifierFor: (input: unknown): string | null => {
      const desc = (input as { description?: unknown }).description
      return typeof desc === 'string' ? desc : null
    },

    async run(input: unknown, ctx: ToolContext) {
      const { prompt, description, model, allowedTools, runInBackground } = input as {
        prompt?: unknown
        description?: unknown
        model?: unknown
        allowedTools?: unknown
        runInBackground?: unknown
      }

      if (typeof prompt !== 'string' || prompt === '') {
        return { output: 'Agent tool requires a non-empty "prompt" string.', isError: true }
      }
      if (typeof description !== 'string' || description === '') {
        return { output: 'Agent tool requires a non-empty "description" string.', isError: true }
      }

      // Build child client — optionally override model
      let client: ModelClient
      if (typeof model === 'string' && model !== '') {
        const parsed = parseModelSpec(model, deps.settings)
        if (parsed.error) return { output: parsed.error, isError: true }
        client = parsed.client!
      } else {
        client = deps.getClient()
      }

      // Build child registry: clone parent, remove Agent, apply allowedTools filter
      const childRegistry = buildChildRegistry(deps.registry, allowedTools)

      const executeSubAgent = async (): Promise<string> => {
        const conversation = new Conversation()
        const sysPrompt = deps.getSystemPrompt() + SUB_AGENT_SUFFIX

        let finalText = ''
        for await (const event of runAgent({
          conversation,
          client,
          registry: childRegistry,
          userText: prompt,
          config: {
            model: client.getModel(),
            max_tokens: 16384,
            system: sysPrompt,
          },
          cwd: ctx.cwd,
          signal: ctx.signal,
          maxTurns: SUB_AGENT_MAX_TURNS,
          tracker: ctx.tracker,
          settings: deps.settings,
          sessionAllow: deps.sessionAllow,
          canUseTool: deps.canUseTool,
        })) {
          if (event.type === 'text-delta') {
            finalText += event.text
          }
        }
        return finalText || '(sub-agent produced no text output)'
      }

      if (runInBackground === true && deps.onBackground) {
        executeSubAgent().then(
          (result) => deps.onBackground!(description, result),
          () => deps.onBackground!(description, '(sub-agent background execution failed)'),
        )
        return { output: `Sub-agent "${description}" launched in background. You will be notified when it finishes.` }
      }

      return { output: await executeSubAgent() }
    },
  }
}

function buildChildRegistry(
  parent: ToolRegistry,
  allowedTools: unknown,
): ToolRegistry {
  const child = new ToolRegistry()
  const whitelist = Array.isArray(allowedTools)
    ? new Set((allowedTools as unknown[]).filter((t): t is string => typeof t === 'string'))
    : null

  for (const tool of parent.list()) {
    if (tool.name === 'Agent') continue
    if (whitelist && !whitelist.has(tool.name)) continue
    child.register(tool)
  }
  return child
}

function parseModelSpec(
  spec: string,
  settings: ResolvedSettings,
): { client?: ModelClient; error?: string } {
  const slash = spec.indexOf('/')
  if (slash <= 0) {
    return { error: `Invalid model format: "${spec}". Expected "providerId/modelName".` }
  }
  const providerId = spec.slice(0, slash)
  const modelName = spec.slice(slash + 1)
  if (!modelName) {
    return { error: `Invalid model format: "${spec}". Model name is empty.` }
  }
  try {
    const providerConfig = getProviderConfig(settings, providerId)
    return { client: createModelClient(providerConfig, modelName) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `Failed to create client for "${spec}": ${msg}` }
  }
}
