import type { Message, ContentBlock, StreamEvent, ModelConfig, Usage, ResolvedSettings, PermissionRequest, PermissionVerdict } from './types.js'
import { emptyUsage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolContext, ToolRegistry, FileReadTracker, Tool } from './tool.js'
import { createFileTracker } from './tool.js'
import { decide } from './permission.js'
import { appendAllowRule } from './settings.js'
import { DEFAULT_SYSTEM_PROMPT } from './prompt.js'
import type { Conversation } from './conversation.js'

/** 每个用户回合内模型<->工具往返次数的默认上限（故障模式①）。 */
export const DEFAULT_MAX_TURNS = 50

/** 未提供 settings 时的宽松回退：全部放行（保持 Phase 4 行为，便于旧测试/无头调用）。 */
const PERMISSIVE_SETTINGS: ResolvedSettings = {
  tools: {},
  permissions: { defaultMode: 'bypassPermissions', allow: [], ask: [], deny: [] },
  providers: {},
}

export interface RunAgentOptions {
  conversation: Conversation
  client: ModelClient
  registry: ToolRegistry
  /** 本回合用户的新输入。 */
  userText: string
  config: ModelConfig
  cwd: string
  signal: AbortSignal
  maxTurns?: number
  /**
   * read-before-edit 用的文件追踪器。由调用方（TUI）按会话持有并传入，
   * 这样跨多次 runAgent 调用（多个用户回合）的读取记录得以保留。
   * 缺省时每次新建一个 —— 测试与无头调用无需关心。
   */
  tracker?: FileReadTracker
  /** 解析后的设置；缺省时回退为全允许（保持 Phase 4 行为）。 */
  settings?: ResolvedSettings
  /**
   * ask 判定的交互回调；缺省（无头/测试）时 ask 一律按 deny 处理。
   * 契约：实现必须支持并发调用（多个未兑现的 promise 同时在飞）—— 同轮只读批并发时
   * 可能多个工具同时走到 ask。TUI 的实现是权限请求队列（tui/permissionQueue.ts）；
   * 单 resolver 的实现会让第二个 ask 覆盖第一个，Promise.all 永不 settle（死锁）。
   */
  canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>
  /** 本会话内存覆盖层（额外 allow 规则）。由调用方持有以跨回合保留。 */
  sessionAllow?: string[]
  /** allow_persist 时的写盘动作；缺省调用 settings 的 appendAllowRule。 */
  onPersistAllow?: (rule: string) => void
  /**
   * Bash 的 `cd` 改变工作目录时回调（传入新的绝对 cwd）。调用方（TUI）据此更新
   * 自己持有的会话 cwd,使下一个用户回合的 `opts.cwd` 接续本回合结束时的目录。
   * 缺省时 cd 仅在本回合内的后续工具间生效,回合结束后不保留。
   */
  onCwdChange?: (cwd: string) => void
}

interface PendingToolUse {
  id: string
  name: string
  input: unknown
}

/**
 * runAgent —— Agent 循环（spec §4.2）。驱动模型和工具，产出一个与厂商
 * 无关的事件流供 UI 订阅。
 *
 * 循环：问模型 -> 如果它想用工具，就运行工具并把结果回喂 -> 再问 -> ...
 * 直到模型结束本回合（或我们触达 maxTurns）。
 *
 * 新消息（用户输入、助手的工具调用、工具结果）先在本地暂存（staged），
 * 只在干净完成时才原子性地提交进 `conversation`。如果回合中途出错或被中断，
 * 什么都不提交 —— 这样账本永远不会以一个悬空的 user/tool_result 收尾而
 * 破坏角色交替。
 */
export async function* runAgent(opts: RunAgentOptions): AsyncIterable<StreamEvent> {
  const { conversation, client, registry, userText, config, cwd, signal } = opts
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const tracker = opts.tracker ?? createFileTracker()
  const settings = opts.settings ?? PERMISSIVE_SETTINGS
  const sessionAllow = opts.sessionAllow ?? []
  const onPersistAllow = opts.onPersistAllow ?? ((rule: string): void => appendAllowRule(rule))

  // agent 持有自己的身份提示词：调用方没指定 system 时注入通用默认值。
  // 放在这里（而非某个 client）保证任何厂商的 client 都获得一致的 agent 行为。
  const effectiveConfig: ModelConfig = {
    ...config,
    system: config.system ?? DEFAULT_SYSTEM_PROMPT,
  }

  const base = conversation.getMessages()
  const staged: Message[] = [{ role: 'user', content: [{ type: 'text', text: userText }] }]
  const turnUsage: Usage = emptyUsage()

  const toolDefs = registry.getDefinitions(settings.tools)

  // 会话当前工作目录。Bash 的 cd 通过 ctx.setCwd 回写到这里,既让本回合后续工具
  // 看到新目录,也通过 onCwdChange 透出给调用方以跨回合接续。
  let sessionCwd = cwd

  let clean = false

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal.aborted) {
      yield { type: 'warning', message: 'Interrupted.' }
      return // 丢弃 staged —— 什么都不提交
    }

    let text = ''
    const toolUses: PendingToolUse[] = []
    let stopReason = ''
    let errored = false

    for await (const event of client.sendMessages(
      [...base, ...staged],
      effectiveConfig,
      toolDefs,
      signal, // 接到底层 SDK：流卡死时 Esc 能真正取消（否则 for-await 永久阻塞）。
    )) {
      if (event.type === 'text-delta') {
        text += event.text
        yield event
      } else if (event.type === 'tool-use') {
        toolUses.push({ id: event.id, name: event.name, input: event.input })
        yield event
      } else if (event.type === 'message-start') {
        yield event
      } else if (event.type === 'message-stop') {
        stopReason = event.stop_reason
        turnUsage.input_tokens += event.usage.input_tokens
        turnUsage.output_tokens += event.usage.output_tokens
        // 缓存读写也要累加进回合总计，否则 totalUsage 的缓存统计恒为 0，footer 永远显示 0k。
        turnUsage.cache_read_input_tokens =
          (turnUsage.cache_read_input_tokens ?? 0) + (event.usage.cache_read_input_tokens ?? 0)
        turnUsage.cache_creation_input_tokens =
          (turnUsage.cache_creation_input_tokens ?? 0) + (event.usage.cache_creation_input_tokens ?? 0)
        yield event
      } else if (event.type === 'error') {
        yield event
        errored = true
        break
      }
    }

    if (errored) return // 模型调用失败时什么都不提交

    // 重建助手消息（text + 任何 tool_use 块）并暂存它。
    const assistantContent: ContentBlock[] = []
    if (text) assistantContent.push({ type: 'text', text })
    for (const tu of toolUses) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
    }
    staged.push({ role: 'assistant', content: assistantContent })

    // 没有请求工具 -> 模型完事了。提交并结束。
    if (stopReason !== 'tool_use' || toolUses.length === 0) {
      // 'max_tokens'（Anthropic 原生 / OpenAI 'length' 归一而来）= 回复被 max_tokens 截断，
      // 而非自然结束。告警提示本回合可能不完整，免得静默把半截回复当成最终答案。
      if (stopReason === 'max_tokens') {
        yield { type: 'warning', message: `模型输出在 max_tokens 处被截断，本回合可能不完整。` }
      }
      clean = true
      break
    }

    // 执行每个被请求的工具（先过权限闸门），并把结果作为一条 user 消息暂存。
    //
    // 同一轮里的多个 tool_use 之间天然无数据依赖（模型一次性请求时还没看到任何结果，
    // 有依赖会分轮做）。但「无数据依赖」≠「无副作用」：Bash 的 cd 改写共享 sessionCwd、
    // Edit 的乐观锁竞争同一文件。所以只在「整批全是只读工具」时才并发 —— 只读工具不调
    // setCwd（cwd 全程不变、共享快照无碍），也不竞争文件锁；混进一个写工具就维持串行。
    //
    // 只读 ≠ 免审：decide() 里 ask 规则先于 readOnly 自动放行判定，并发批内可能多个
    // 工具同时走到 ask。这由 canUseTool 的契约兜住：实现必须支持并发调用（多个未兑现
    // 的 promise 同时在飞）—— TUI 的实现是权限请求队列（弹框逐个排队、互不覆盖，见
    // tui/permissionQueue.ts）；headless 调用方自行保证其 canUseTool 可并发。
    const allReadOnly = toolUses.every((tu) => registry.get(tu.name)?.readOnly === true)

    // 每个工具调用按会话当前 cwd 重建 ctx —— 上一条 Bash 的 cd 才能被下一条看到。
    const buildCtx = (): ToolContext => ({
      cwd: sessionCwd,
      signal,
      tracker,
      setCwd: (p: string): void => {
        sessionCwd = p
        opts.onCwdChange?.(p)
      },
    })
    // 闸门依赖按调用时的 sessionCwd 现取 —— 串行路径里上一条 Bash 的 cd 改了 cwd,
    // 后续工具的路径规则匹配（decide）才看得到新目录。
    const gateDeps = (): GateDeps => ({
      settings, sessionAllow, cwd: sessionCwd, canUseTool: opts.canUseTool, onPersistAllow,
    })

    let outputs: Array<{ output: string; isError: boolean }>
    if (allReadOnly && toolUses.length > 1) {
      // 并发执行整批只读工具。gateAndRunTool 把工具异常 try/catch 成 isError 结果;
      // ask 路径的 canUseTool 按契约可并发(见上),故 Promise.all 不会卡死。
      // 仅 canUseTool / onPersistAllow 自身抛错才会整体 reject —— 串行路径下同样中止回合,非并发新增风险。
      outputs = await Promise.all(toolUses.map((tu) => gateAndRunTool(registry, tu, buildCtx(), gateDeps())))
    } else {
      // 含写工具（或单个工具）：串行,保住 cd / 乐观锁的顺序语义。
      outputs = []
      for (const tu of toolUses) {
        outputs.push(await gateAndRunTool(registry, tu, buildCtx(), gateDeps()))
      }
    }

    // 按请求顺序回喂结果（tool_result 靠 id 匹配,顺序非强制,但保持一致更稳）。
    const resultBlocks: ContentBlock[] = []
    for (let i = 0; i < toolUses.length; i++) {
      const tu = toolUses[i]!
      const result = outputs[i]!
      yield {
        type: 'tool-result',
        id: tu.id,
        name: tu.name,
        output: result.output,
        is_error: result.isError,
      }
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.output,
        is_error: result.isError,
      })
    }
    staged.push({ role: 'user', content: resultBlocks })
    // 循环：把工具结果回喂给模型
  }

  if (!clean) {
    // 在循环中途触达 maxTurns：最后一条暂存消息是 user 的 tool_result，
    // 所以补一条助手收尾消息以保持角色交替合法，然后告警。
    staged.push({
      role: 'assistant',
      content: [{ type: 'text', text: `[Stopped: reached max turns (${maxTurns}).]` }],
    })
    yield { type: 'warning', message: `Reached max turns (${maxTurns}); stopping.` }
  }

  // 原子性地提交整个回合。
  for (const m of staged) conversation.append(m)
  conversation.addUsage(turnUsage)
}

interface GateDeps {
  settings: ResolvedSettings
  sessionAllow: string[]
  cwd: string
  canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>
  onPersistAllow: (rule: string) => void
}

/**
 * 权限闸门 + 执行（spec §7）。未知工具按故障模式④回喂；deny 合成拒绝结果不执行；
 * ask 走 canUseTool（无回调则默认 deny）；allow_session/allow_persist 推进会话
 * 覆盖层，后者额外写盘。
 */
async function gateAndRunTool(
  registry: ToolRegistry,
  tu: PendingToolUse,
  ctx: ToolContext,
  deps: GateDeps,
): Promise<{ output: string; isError: boolean }> {
  const tool: Tool | undefined = registry.get(tu.name)
  if (!tool) return { output: `Unknown tool: ${tu.name}`, isError: true }

  const specifier = tool.specifierFor?.(tu.input) ?? null
  const { decision, rule, matched, reason } = decide(tool, specifier, deps.settings, deps.sessionAllow, deps.cwd)

  if (decision === 'deny') {
    return { output: `Permission denied by settings (${matched ?? rule}).`, isError: true }
  }

  if (decision === 'ask') {
    const verdict = deps.canUseTool
      ? await deps.canUseTool({ toolName: tu.name, input: tu.input, specifier, rule, reason })
      : 'deny'
    if (verdict === 'deny') return { output: `Permission denied by user (${rule}).`, isError: true }
    if (verdict === 'allow_session' || verdict === 'allow_persist') {
      if (!deps.sessionAllow.includes(rule)) deps.sessionAllow.push(rule)
    }
    if (verdict === 'allow_persist') deps.onPersistAllow(rule)
  }

  return runOneTool(registry, tu, ctx)
}

/** 运行单个工具，把"未知工具"和抛出的错误转换成 is_error 结果（故障模式④）。 */
async function runOneTool(
  registry: ToolRegistry,
  tu: PendingToolUse,
  ctx: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  const tool = registry.get(tu.name)
  if (!tool) {
    return { output: `Unknown tool: ${tu.name}`, isError: true }
  }
  try {
    const result = await tool.run(tu.input, ctx)
    return { output: result.output, isError: result.isError ?? false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { output: `Tool "${tu.name}" failed: ${message}`, isError: true }
  }
}
