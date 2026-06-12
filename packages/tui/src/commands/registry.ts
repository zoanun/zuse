import { homedir } from 'node:os'
import type { SlashCommand, CommandInfo } from './types.js'
import { saveConversation, loadConversation, listAutoSessions, loadAutoSession } from './sessionStore.js'
import { installTerminalSetup } from './terminalSetup.js'
import { resolveModelSelection, modelNames, DEFAULT_PROVIDER_ID, type ResolvedSettings, type ErrorCategory } from '@zuse/core'

/** /model 交互式选择器的一个候选：provider+model 配对，外加是否为当前激活项。 */
export interface ModelOption {
  providerId: string
  model: string
  /** 是否当前激活的 provider+model 配对（供选择器高亮）。 */
  isCurrent: boolean
  /** 运行时(内存)标注:该 provider/model 本会话已判不可用,picker 灰显并打标签。 */
  unavailable?: { reason: ErrorCategory }
}

/**
 * 把 settings 里各 provider 的 models 清单展开成选择器候选。
 * 当前项按 provider+model 同时匹配才标记（重名模型不误标）。
 * 当前模型不在任何已声明清单中（扁平默认配置 / 未列 models 的 provider / 离群配置）时，
 * 补一条当前项并高亮——否则选择器里看不到「现在用的是什么」。
 */
export function buildModelOptions(
  settings: ResolvedSettings,
  currentProviderId: string,
  currentModel: string,
  badKeys?: ReadonlyMap<string, ErrorCategory>,
): ModelOption[] {
  const options: ModelOption[] = []
  let currentSeen = false
  for (const [id, p] of Object.entries(settings.providers)) {
    for (const m of modelNames(p)) {
      const isCurrent = id === currentProviderId && m === currentModel
      if (isCurrent) currentSeen = true
      const reason = badKeys?.get(`${id}/${m}`)
      options.push({ providerId: id, model: m, isCurrent, ...(reason ? { unavailable: { reason } } : {}) })
    }
  }
  if (!currentSeen) {
    options.push({ providerId: currentProviderId, model: currentModel, isCurrent: true })
  }
  return options
}

/** 解析后的斜杠输入。null 表示"不是命令 —— 当作一条聊天消息处理"。 */
interface ParsedCommand {
  name: string
  args: string
}

const help: SlashCommand = {
  name: 'help',
  description: '列出所有可用命令',
  run: ({ print }) => {
    const lines = COMMANDS.map((c) => `  /${c.name.padEnd(8)} ${c.description}`)
    print(['可用命令:', ...lines].join('\n'))
  },
}

/** 朴素 Levenshtein 编辑距离，用于在模型名拼错时挑出最接近的候选。滚动一行 DP。 */
export function editDistance(a: string, b: string): number {
  const n = b.length
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = new Array<number>(n + 1)
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
    prev = curr
  }
  return prev[n] ?? 0
}

/**
 * 从候选里挑编辑距离最小者作为「你是否想要…」的建议（模型名、provider 名通用）。
 * 距离过远（> 名字长度的 1/3，且至少容许 2）则返回 undefined，避免乱猜出风马牛不相及的名字。
 */
export function nearestMatch(target: string, candidates: string[]): string | undefined {
  let best: string | undefined
  let bestD = Infinity
  for (const c of candidates) {
    const d = editDistance(target, c)
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  if (best === undefined) return undefined
  return bestD <= Math.max(2, Math.floor(target.length / 3)) ? best : undefined
}

/** apiKey 打码：仅留首 6 + 末 4，足以辨认是哪把 key 又不泄露全文。 */
function maskKey(key: string | undefined): string {
  if (!key) return '(未设置)'
  if (key.length <= 12) return '*** (已设置)'
  return `${key.slice(0, 6)}…${key.slice(-4)} (已设置)`
}

const config: SlashCommand = {
  name: 'config',
  description: '显示当前生效配置（三层合并后）',
  run: ({ settings, print }) => {
    const p = settings.permissions
    const t = settings.tools
    const fmt = (arr: string[]): string => (arr.length ? arr.join(', ') : '(空)')
    const tools =
      t.enabled || t.disabled
        ? `enabled=${t.enabled?.join(', ') ?? '全部'}; disabled=${t.disabled?.join(', ') ?? '无'}`
        : '(全部启用)'
    print(
      [
        '当前生效配置（三层合并后）:',
        `  model:       ${settings.model ?? '(默认)'}`,
        `  maxTokens:   ${settings.maxTokens ?? '(默认)'}`,
        `  baseURL:     ${settings.baseURL ?? '(默认)'}`,
        `  apiKey:      ${maskKey(settings.apiKey)}`,
        `  defaultMode: ${p.defaultMode}`,
        `  allow:       ${fmt(p.allow)}`,
        `  ask:         ${fmt(p.ask)}`,
        `  deny:        ${fmt(p.deny)}`,
        `  tools:       ${tools}`,
      ].join('\n'),
    )
  },
}

const clear: SlashCommand = {
  name: 'clear',
  description: '清空对话历史',
  run: ({ clear, print }) => {
    clear()
    print('已清空对话。')
  },
}

const save: SlashCommand = {
  name: 'save',
  description: '保存当前对话：/save <名称>',
  takesArgs: true,
  run: async ({ args, conversation, print }) => {
    if (!args) {
      print('用法：/save <名称>')
      return
    }
    const path = await saveConversation(args, conversation)
    print(`已保存到 ${path}`)
  },
}

const load: SlashCommand = {
  name: 'load',
  description: '加载已保存的对话：/load <名称>',
  takesArgs: true,
  run: async ({ args, load: replaceConversation, print }) => {
    if (!args) {
      print('用法：/load <名称>')
      return
    }
    const conv = await loadConversation(args)
    replaceConversation(conv)
    print(`已加载 "${args}"（${conv.length} 条消息）。`)
  },
}

const resume: SlashCommand = {
  name: 'resume',
  description: '列出或续接本目录的自动会话：/resume [<序号>]',
  run: async ({ args, cwd, adoptSession, print }) => {
    const metas = await listAutoSessions(cwd)
    if (metas.length === 0) {
      print('本目录还没有自动保存的会话。')
      return
    }
    if (!args) {
      // 无参:列表(1 = 最新)。
      const lines = metas.map((m, i) => {
        const when = m.updatedAt.slice(0, 16).replace('T', ' ')
        return `  ${i + 1}. ${when}  ${String(m.messageCount).padStart(3)} 条  ${m.firstUserText}`
      })
      print(['本目录的自动会话(/resume <序号> 续接):', ...lines].join('\n'))
      return
    }
    // 参数:列表序号(1 最新)或完整会话 id 均可。
    const n = Number.parseInt(args, 10)
    const meta =
      Number.isInteger(n) && n >= 1 && String(n) === args ? metas[n - 1] : metas.find((m) => m.id === args)
    if (!meta) {
      print(`没有匹配 "${args}" 的会话。先用 /resume 查看列表。`)
      return
    }
    const loaded = await loadAutoSession(cwd, meta.id)
    adoptSession(loaded.conversation, loaded.id, loaded.createdAt, loaded.checkpoints)
    print(`已续接会话 ${meta.id}(${meta.messageCount} 条消息)。`)
  },
}

const revert: SlashCommand = {
  name: 'revert',
  description: '回滚到某回合开始前(文件 + 对话一起回):/revert [<序号> [--yes]]',
  run: async ({ args, checkpoints, checkpointDiff, revertToCheckpoint, print }) => {
    if (checkpoints.length === 0) {
      print('本会话还没有检查点(每个回合开始前自动打点;git 不可用时降级为无检查点)。')
      return
    }
    const list = [...checkpoints].reverse() // 1 = 最新
    const when = (at: string): string => at.slice(0, 16).replace('T', ' ')
    if (!args) {
      const lines = list.map((c, i) => `  ${i + 1}. ${when(c.at)}  ${c.label}`)
      print(
        [
          '本会话的检查点(/revert <序号> 回滚到该回合开始前):',
          ...lines,
          '影子仓库保留全部历史,误滚可再 /revert 到更近的检查点。',
        ].join('\n'),
      )
      return
    }
    const parts = args.split(/\s+/)
    const confirmed = parts.includes('--yes')
    const numToken = parts.find((x) => x !== '--yes') ?? ''
    const n = Number.parseInt(numToken, 10)
    const cp = Number.isInteger(n) && n >= 1 && String(n) === numToken ? list[n - 1] : undefined
    if (!cp) {
      print(`没有序号为 "${numToken}" 的检查点。先用 /revert 查看列表。`)
      return
    }
    if (!confirmed) {
      // 回滚是破坏性操作:撤销的是「该检查点之后的全部文件改动」,包括用户自己手改的
      // 部分。先展示真实范围(diffStat),要求显式 --yes 确认后才执行。
      const stat = await checkpointDiff(cp).catch(
        (e: unknown) => `(改动对比失败:${e instanceof Error ? e.message : String(e)})`,
      )
      print(
        [
          `将回滚到检查点 ${n}(${when(cp.at)}「${cp.label}」开始前),以下文件改动将被撤销:`,
          stat,
          `回滚同时截断该回合起的对话历史。确认请执行:/revert ${n} --yes`,
        ].join('\n'),
      )
      return
    }
    // revertToCheckpoint 失败会抛错(文件没回去,账本不动),由 submit 的统一 catch 透出。
    print(await revertToCheckpoint(cp))
  },
}

const compact: SlashCommand = {
  name: 'compact',
  description: '压缩对话历史:老回合折叠为摘要,保留最近回合',
  run: async ({ compact: doCompact, print }) => {
    print('压缩中…(调用模型生成摘要)')
    print(await doCompact())
  },
}

const model: SlashCommand = {
  name: 'model',
  description: '查看或切换模型：/model [<provider/model>] [--save]',
  run: ({ args, settings, switchModel, print, openModelSelector }) => {
    if (!args) {
      // 无参：打开交互式选择器（方向键 + 输入过滤 + 滚动视口）。候选清单与当前项高亮
      // 由 App 用 buildModelOptions 计算；选中即切换（不写盘），--save 走下方直输路径。
      openModelSelector()
      return
    }
    // 有参：切换模型，可选 --save 写盘。
    const parts = args.split(/\s+/)
    const persist = parts.includes('--save')
    // 只取第一个非 --save 的 token 作为模型引用；模型名不含空格，
    // join(' ') 会把多余词拼进名字（如 "/model a/b note" → "b note"）造成切换失败。
    const ref = parts.find((x) => x !== '--save') ?? ''
    if (!ref) {
      print('用法：/model <provider/model> [--save]')
      return
    }
    // 含斜杠：按 provider/model 解析；否则只换 model，保留当前 provider。
    const sel = ref.includes('/')
      ? resolveModelSelection({ ...settings, model: ref })
      : { providerId: resolveModelSelection(settings).providerId, model: ref }
    // 校验 provider：引用了一个未配置的 provider（扁平 default provider 例外，它本就不在 map 里）。
    // 多半是 provider 名打错（如 "pencode" → "opencode"）。和 model 打错一样：拒绝切换、给最接近的建议，
    // 否则会落到 switchModel 里抛一个干巴巴的 "not configured" 错误，还不提示正确的名字。
    if (sel.providerId !== DEFAULT_PROVIDER_ID && !settings.providers[sel.providerId]) {
      const suggestion = nearestMatch(sel.providerId, Object.keys(settings.providers))
      print(
        `⚠ Provider "${sel.providerId}" 未配置${suggestion ? `，你是否想要 "${suggestion}"？` : '。'}已保留当前模型（未切换）。`,
      )
      return
    }
    // 校验 model：provider 声明了 models 清单、但目标不在其中。
    const declared = modelNames(settings.providers[sel.providerId])
    if (declared.length > 0 && !declared.includes(sel.model)) {
      const suggestion = nearestMatch(sel.model, declared)
      if (suggestion) {
        // 有高置信度的最接近候选 = 几乎肯定是手滑打错。拒绝切换、保留当前模型，
        // 让用户照建议重输；否则会切到一个必然 404/401 的模型，还把列表里的星标弄丢。
        print(`⚠ 模型 "${sel.model}" 不在 provider "${sel.providerId}" 的已声明列表中，你是否想要 "${suggestion}"？已保留当前模型（未切换）。`)
        return
      }
      // 无相近候选：可能是清单未收录的合法模型。保留「自由输入」语义仍允许切换，
      // 但警告 + 拒绝把未知模型 --save 写盘，以免错字被持久化、每次启动都加载到会报错的模型。
      print(
        `⚠ 模型 "${sel.model}" 不在 provider "${sel.providerId}" 的已声明列表中。` +
          (persist ? ' 已忽略 --save（未知模型不写盘）。' : ''),
      )
      print(switchModel(sel, false))
      return
    }
    print(switchModel(sel, persist))
  },
}

const tools: SlashCommand = {
  name: 'tools',
  description: '列出暴露给模型的工具',
  run: ({ registry, settings, print }) => {
    // 用 getDefinitions（而非 list）：它按 settings.tools 的 enabled/disabled 过滤，
    // 列出的正是模型这一会话真正能看到/调用的工具，而非全部已注册的。
    const defs = registry.getDefinitions(settings.tools)
    if (defs.length === 0) {
      print('（当前没有暴露给模型的工具——检查 settings.tools 的 enabled/disabled。）')
      return
    }
    const lines = [`可用工具（${defs.length} 个，已暴露给模型）:`]
    for (const d of defs) {
      // 工具描述常是多行长文，这里只取首行并截断，保证一行一个工具、列表清爽。
      const summary = (d.description.split('\n')[0] ?? '').trim()
      const short = summary.length > 60 ? summary.slice(0, 59) + '…' : summary
      lines.push(`  ${d.name.padEnd(10)} ${short}`)
    }
    print(lines.join('\n'))
  },
}

const history: SlashCommand = {
  name: 'history',
  description: '说明如何查看历史对话',
  run: ({ print }) => {
    // cc 式渲染：已完成的消息全部打进终端滚动区，没有应用内滚动，
    // 直接用终端自带的滚动条 / 鼠标滚轮向上翻即可。
    print('完整对话历史都在终端滚动区里，直接用终端的滚动条或鼠标滚轮向上查看即可。')
  },
}

const terminalSetup: SlashCommand = {
  name: 'terminal-setup',
  description: '为 VSCode/Cursor/Windsurf 集成终端启用 Ctrl+Enter 换行',
  run: async ({ print }) => {
    // 在当前进程的真实环境上执行；纯逻辑（识别/路径/合并）已在 terminalSetup.test 覆盖。
    const res = await installTerminalSetup({ env: process.env, platform: process.platform, home: homedir() })
    print(res.message)
  },
}

/** 命令表。新增一个命令 = 在这里加一条（数据驱动）。 */
const COMMANDS: SlashCommand[] = [help, config, clear, save, load, resume, revert, compact, model, tools, history, terminalSetup]

/** 把原始输入拆成命令名 + 参数；若不是斜杠命令则返回 null。 */
export function parseInput(input: string): ParsedCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const space = trimmed.indexOf(' ')
  if (space === -1) return { name: trimmed.slice(1), args: '' }
  return { name: trimmed.slice(1, space), args: trimmed.slice(space + 1).trim() }
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name)
}

/**
 * 把命令表投影成 `/` 菜单所需的元信息（名字/描述/是否需参数），按声明顺序。
 * 菜单与命令实现解耦：只暴露展示与选中所需字段，不泄露 run。
 */
export function listCommands(): CommandInfo[] {
  return COMMANDS.map((c) => ({ name: c.name, description: c.description, takesArgs: c.takesArgs ?? false }))
}
