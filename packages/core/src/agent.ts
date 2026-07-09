import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, ContentBlock, StreamEvent, ModelConfig, Usage, ResolvedSettings, PermissionRequest, PermissionVerdict, MessageAttachment } from './types.js'
import { emptyUsage } from './types.js'
import type { ModelClient } from './model-client.js'
import type { ToolContext, ToolRegistry, FileReadTracker, Tool } from './tool.js'
import { createFileTracker } from './tool.js'
import { decide } from './permission.js'
import { appendAllowRule } from './settings.js'
import { DEFAULT_SYSTEM_PROMPT } from './prompt.js'
import { runHooks } from './hooks.js'
import { steerFoldSuffix } from './steer.js'
import type { Conversation } from './conversation.js'

/** 每个用户回合内模型<->工具往返次数的默认上限（故障模式①）。 */
export const DEFAULT_MAX_TURNS = 50

export const MAX_TURNS_STOP_TEXT = (n: number): string =>
  `[CRITICAL: Maximum tool turns (${n}) reached. Tools are now disabled. ` +
  `Do NOT attempt any more tool calls. Summarize what was accomplished ` +
  `and what remains, then end your response.]`

/**
 * 工具输出落盘阈值（字符数）。超过此值的非错误工具结果截断+存文件,
 * 上下文只保留头部+文件路径引用。对齐 CC 的 50K 策略。
 */
export const TOOL_OUTPUT_SPILL_THRESHOLD = 50_000
const SPILL_HEAD_CHARS = 10_000

function spillDir(cwd: string): string {
  return process.env.ZUSE_TOOL_OUTPUT_DIR ?? join(cwd, '.zuse', 'tool-output')
}

function spillToolOutput(output: string, toolName: string, toolId: string, cwd: string): string {
  const dir = spillDir(cwd)
  mkdirSync(dir, { recursive: true })
  const filename = `${toolName}-${toolId}-${Date.now()}.txt`
  const filepath = join(dir, filename)
  writeFileSync(filepath, output, 'utf8')
  const head = output.slice(0, SPILL_HEAD_CHARS)
  return (
    `${head}\n\n` +
    `[truncated: output was ${output.length} chars; showing first ${SPILL_HEAD_CHARS}. ` +
    `Full output saved to ${filepath} — use Read or Grep to inspect it]`
  )
}

/**
 * 复读保护：模型退化进重复循环（同一短串无限复读，如 "测过了！测过了！…"）时,在撞
 * max_tokens 之前就中止本回合,免得糊屏 + 烧 token。仅当输出已经很长时才检测,且要求某个
 * ≤UNIT 长的单元在尾部【连续精确重复】≥REPEATS 次 —— 正常文本（含代码/表格）几乎不会触发。
 */
const REPETITION_MIN_CHARS = 4000
const REPETITION_UNIT_MAX = 200
const REPETITION_MIN_REPEATS = 24

export function isRunawayRepetition(text: string): boolean {
  if (text.length < REPETITION_MIN_CHARS) return false
  // 只看尾部窗口（最多 UNIT*REPEATS 个字符），按各种单元长度从尾向前数连续精确重复。
  const window = text.slice(-REPETITION_UNIT_MAX * REPETITION_MIN_REPEATS)
  for (let p = 1; p <= REPETITION_UNIT_MAX; p++) {
    const unit = window.slice(window.length - p)
    if (unit.trim() === '') continue // 纯空白单元忽略（连续缩进/换行不算退化）
    // 从尾部向前,数有多少个连续的 p 长块恰好等于该单元。
    let repeats = 1
    let pos = window.length - p
    while (pos - p >= 0 && window.slice(pos - p, pos) === unit) { repeats++; pos -= p }
    if (repeats >= REPETITION_MIN_REPEATS) return true
  }
  return false
}

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
  /**
   * Mid-turn steering: called after each tool batch completes. Returns the user's
   * queued steer text (concatenated if multiple), or null if nothing queued.
   * The text is appended to the last tool result before feeding back to the model.
   */
  consumeSteer?: () => string | null
  /**
   * 本回合用户上传的图片引用（id/name/mediaType/…，不含 base64）。挂到本回合暂存的
   * user 消息的 `attachments` 上，随账本持久化；image 块的展开是 expandAttachments 的事。
   */
  userAttachments?: MessageAttachment[]
  /**
   * 发送前的图片展开钩子（运行期依赖，类似 client —— 不是模型参数，故不放 ModelConfig）。
   * 契约：读每条消息的 `attachments`→base64→在该条 content 前插入 image 块，返回**新副本**；
   * 绝不 mutate 入参消息/其 content。core 不认识 `~/.zuse/uploads`,只调这个注入的函数（服务端
   * 提供实现），保持解耦。缺省时行为完全不变（直接发原消息数组，不展开）。
   */
  expandAttachments?: (messages: Message[]) => Promise<Message[]>
}

interface PendingToolUse {
  id: string
  name: string
  input: unknown
  /** 模型生成的参数串不是合法 JSON 时的原始串（见 StreamEvent 的 invalid_args）。 */
  invalidArgs?: string
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
  // 本回合的 user 消息：text 块 + attachments 引用（若有）。image 块不在这里放 —— 展开是
  // expandAttachments 的事，账本/持久化的消息绝不含 base64。
  const stagedUser: Message = { role: 'user', content: [{ type: 'text', text: userText }] }
  if (opts.userAttachments && opts.userAttachments.length > 0) {
    stagedUser.attachments = opts.userAttachments
  }
  const staged: Message[] = [stagedUser]
  const turnUsage: Usage = emptyUsage()

  // 会话当前工作目录。Bash 的 cd 通过 ctx.setCwd 回写到这里,既让本回合后续工具
  // 看到新目录,也通过 onCwdChange 透出给调用方以跨回合接续。
  let sessionCwd = cwd

  let clean = false

  for (let turn = 0; turn < maxTurns; turn++) {
    // Re-read each turn so dynamically registered tools (e.g. via McpSearch)
    // become visible to the model on the next turn.
    const toolDefs = registry.getDefinitions(settings.tools)
    if (signal.aborted) {
      yield { type: 'warning', message: 'Interrupted.' }
      return // 丢弃 staged —— 什么都不提交
    }

    let text = ''
    let lastRepCheck = 0
    const toolUses: PendingToolUse[] = []
    let stopReason = ''
    let errored = false
    let runaway = false

    // 发送前展开图片：把带 attachments 的消息在 content 前插入 image 块，产出请求专用副本。
    // 缺省钩子时直接用原数组（行为不变）；有钩子时只把返回值发出去，原 base/staged 不被 mutate。
    const messages = [...base, ...staged]
    const outbound = opts.expandAttachments ? await opts.expandAttachments(messages) : messages

    for await (const event of client.sendMessages(
      outbound,
      effectiveConfig,
      toolDefs,
      signal, // 接到底层 SDK：流卡死时 Esc 能真正取消（否则 for-await 永久阻塞）。
    )) {
      if (event.type === 'text-delta') {
        text += event.text
        yield event
        // 每多约 500 字符查一次复读；命中即中止本回合。break 会触发底层流的 .return() 收尾。
        // 注意：不丢弃整个回合 —— 那样连用户这轮的提问都会一起消失（账本回到空）。改为
        // 保留用户消息 + 截断后的助手文本（见下 runaway 分支）：掐掉退化的尾巴不回喂垃圾,
        // 但本轮问答仍留痕，用户不会"问了个问题结果整轮蒸发"。
        if (text.length - lastRepCheck >= 500) {
          lastRepCheck = text.length
          if (isRunawayRepetition(text)) {
            yield { type: 'warning', message: 'Detected runaway repetition — stopped this turn (output truncated to keep the conversation clean).' }
            runaway = true
            break
          }
        }
      } else if (event.type === 'tool-use') {
        toolUses.push({ id: event.id, name: event.name, input: event.input, invalidArgs: event.invalid_args })
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

    if (errored) return // 真·模型调用失败（error 事件）：什么都不提交

    if (runaway) {
      // 复读退化：保留用户消息 + 截断后的助手文本（掐掉退化尾巴，不回喂垃圾），提交本回合后结束。
      // 截到 REPETITION_MIN_CHARS：触发时 text 必 ≥ 该阈值，且退化串在尾部，前缀通常仍是有效内容。
      staged.push({
        role: 'assistant',
        content: [{ type: 'text', text: `${text.slice(0, REPETITION_MIN_CHARS)}\n\n[output truncated: runaway repetition detected]` }],
      })
      clean = true
      break
    }

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
        yield { type: 'warning', message: `Model output was truncated at max_tokens. This turn's response may be incomplete.` }
      }
      clean = true
      break
    }

    // 执行每个被请求的工具（先过权限闸门），并把结果作为一条 user 消息暂存。
    //
    // 同一轮里的多个 tool_use 之间天然无数据依赖（模型一次性请求时还没看到任何结果，
    // 有依赖会分轮做）。但「无数据依赖」≠「无副作用」：Bash 的 cd 改写共享 sessionCwd、
    // Edit 的乐观锁竞争同一文件。所以只在「整批都可并发」时才并发；混进一个会抢占共享状态
    // 的工具就维持串行。可并发 = 工具声明了 readOnly（不调 setCwd、不竞争文件锁）或
    // parallelizable（自带隔离上下文,如 Agent 子代理）—— 是 Tool 上的声明式属性,不在这里
    // 硬编码工具名。
    //
    // 可并发 ≠ 免审：decide() 里 ask 规则先于自动放行判定，并发批内可能多个工具同时走到
    // ask。这由 canUseTool 的契约兜住：实现必须支持并发调用（多个未兑现的 promise 同时在
    // 飞）—— TUI 的实现是权限请求队列（弹框逐个排队、互不覆盖，见 tui/permissionQueue.ts）；
    // headless 调用方自行保证其 canUseTool 可并发。
    const allParallelSafe = toolUses.every((tu) => {
      const t = registry.get(tu.name)
      return t?.readOnly === true || t?.parallelizable === true
    })

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

    // 参数非合法 JSON 的调用不过闸、不执行,直接合成回喂 observation(Phase 11);
    // 同轮里的合法调用不连坐,照常执行。合成结果即时 resolve,放进并发批也无副作用。
    const dispatch = (tu: PendingToolUse): Promise<{ output: string; isError: boolean }> =>
      tu.invalidArgs !== undefined
        ? Promise.resolve(invalidJsonResult(tu))
        : gateAndRunTool(registry, tu, buildCtx(), gateDeps())

    // 结果"算出即发"：每个工具一 settle 就 yield 它的 tool-result 事件,让前端能逐个
    // 显示内容/改状态,而不是整批跑完才一起冒出来。回喂给模型的 tool_result 块仍按
    // 【请求顺序】组装(见下),不受发射顺序影响。
    type ToolOutput = { output: string; isError: boolean }
    const outputs = new Array<ToolOutput>(toolUses.length)
    const resultEvent = (i: number, r: ToolOutput): StreamEvent => ({
      type: 'tool-result', id: toolUses[i]!.id, name: toolUses[i]!.name, output: r.output, is_error: r.isError,
    })
    if (allParallelSafe && toolUses.length > 1) {
      // 并发执行整批可并发工具,按【完成顺序】发射结果。gateAndRunTool 把工具异常 try/catch
      // 成 isError 结果;ask 路径的 canUseTool 按契约可并发(见上)。仅 canUseTool /
      // onPersistAllow 自身抛错才会 reject —— Promise.race 同样把它抛出、中止回合,与原
      // Promise.all 行为一致。每个 derived promise 只建一次,复用给多次 race。
      const pending = new Map<number, Promise<{ i: number; r: ToolOutput }>>(
        toolUses.map((tu, i) => [i, dispatch(tu).then((r) => ({ i, r }))]),
      )
      while (pending.size > 0) {
        const { i, r } = await Promise.race(pending.values())
        pending.delete(i)
        outputs[i] = r
        yield resultEvent(i, r)
      }
    } else {
      // 含会抢占共享状态的工具（或单个工具）：串行,保住 cd / 乐观锁顺序;每个工具结束即发射结果。
      for (let i = 0; i < toolUses.length; i++) {
        const r = await dispatch(toolUses[i]!)
        outputs[i] = r
        yield resultEvent(i, r)
      }
    }

    // 回喂模型的结果块按请求顺序组装（tool_result 靠 id 匹配,顺序非强制,但保持一致更稳）。
    const resultBlocks: ContentBlock[] = toolUses.map((tu, i) => ({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: outputs[i]!.output,
      is_error: outputs[i]!.isError,
    }))
    // Mid-turn steer: if the user sent a message while tools were running,
    // append it to the last tool result so the model sees it on the next turn.
    const steer = opts.consumeSteer?.()
    const toolResultMsg: Message = { role: 'user', content: resultBlocks }
    if (steer && resultBlocks.length > 0) {
      const last = resultBlocks[resultBlocks.length - 1]!
      if (last.type === 'tool_result') {
        last.content += steerFoldSuffix(steer)
        // Record the fold structurally on the carrier message so the snapshot projector shows it as
        // a distinct "↪ 插话" bubble and strips it from the tool card by exact text — not by sniffing.
        toolResultMsg.steer = [steer]
      }
    }
    staged.push(toolResultMsg)
    // 循环：把工具结果回喂给模型
  }

  if (!clean) {
    // 在循环中途触达 maxTurns：最后一条暂存消息是 user 的 tool_result，
    // 所以补一条助手收尾消息以保持角色交替合法，然后告警。
    staged.push({
      role: 'assistant',
      content: [{ type: 'text', text: MAX_TURNS_STOP_TEXT(maxTurns) }],
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
  if (!tool) return unknownToolResult(registry, tu.name)

  const specifier = tool.specifierFor?.(tu.input) ?? null
  const { decision, rule, matched, reason } = decide(tool, specifier, deps.settings, deps.sessionAllow, deps.cwd)

  if (decision === 'deny') {
    // settings deny 是硬护栏:配置写死,原样重试必然再拒,要把"换路子"说给模型听。
    return {
      output:
        `此调用被配置规则「${matched ?? rule}」拒绝。这是硬性护栏；` +
        '不要重试同一调用。请改用其他方式，或让用户修改其权限设置。',
      isError: true,
    }
  }

  if (decision === 'ask') {
    const verdict = deps.canUseTool
      ? await deps.canUseTool({ toolName: tu.name, input: tu.input, specifier, rule, reason })
      : 'deny'
    if (verdict === 'deny') {
      // 用户拒绝是本次裁决:下一步是问用户意图,而非立刻原样重发。
      return {
        output:
          `用户拒绝了这次 ${tu.name} 调用（规则：${rule}）。不要重试同一调用。` +
          '请询问用户如何继续，或改用其他方式。',
        isError: true,
      }
    }
    if (verdict === 'allow_session' || verdict === 'allow_persist') {
      if (!deps.sessionAllow.includes(rule)) deps.sessionAllow.push(rule)
    }
    if (verdict === 'allow_persist') deps.onPersistAllow(rule)
  }

  const hookEnv = { toolName: tu.name, toolInput: tu.input, cwd: deps.cwd }
  const preWarnings = runHooks(deps.settings.hooks?.preToolUse, hookEnv).warnings

  const result = await runOneTool(registry, tu, ctx)

  const postWarnings = runHooks(deps.settings.hooks?.postToolUse, hookEnv).warnings
  const allWarnings = [...preWarnings, ...postWarnings]
  if (allWarnings.length > 0) {
    result.output += `\n[Hook warnings: ${allWarnings.join('; ')}]`
  }

  return result
}

/**
 * 坏 JSON tool_use 的 observation(Phase 11):点明哪个工具、回显原始串,并给出
 * 下一步指令(重发),模型下一轮即可自纠。不执行工具 —— 空参运行是静默跑错。
 */
function invalidJsonResult(tu: PendingToolUse): { output: string; isError: boolean } {
  return {
    output:
      `工具调用参数不是合法 JSON(工具:${tu.name})。` +
      `原始参数(已截断):${tu.invalidArgs}。` +
      '请用格式正确的 JSON 参数重新发起该工具调用。',
    isError: true,
  }
}

/** 未知工具的 observation:列出可用工具清单,模型才能自纠工具名(典型:Read 写成 read_file)。 */
function unknownToolResult(
  registry: ToolRegistry,
  name: string,
): { output: string; isError: boolean } {
  const names = registry.list().map((t) => t.name).join(', ') || '(none)'
  return { output: `未知工具:${name}。可用工具:${names}。`, isError: true }
}

/** 运行单个工具，把"未知工具"和抛出的错误转换成 is_error 结果（故障模式④）。 */
async function runOneTool(
  registry: ToolRegistry,
  tu: PendingToolUse,
  ctx: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  const tool = registry.get(tu.name)
  if (!tool) {
    return unknownToolResult(registry, tu.name)
  }
  try {
    const result = await tool.run(tu.input, ctx)
    const isError = result.isError ?? false
    // 非错误的超长输出落盘:截断+存文件+路径引用,模型可用 Read/Grep 按需取。
    const output = !isError && result.output.length > TOOL_OUTPUT_SPILL_THRESHOLD
      ? spillToolOutput(result.output, tu.name, tu.id, ctx.cwd)
      : result.output
    return { output, isError }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { output: `工具「${tu.name}」执行失败:${message}`, isError: true }
  }
}
