import type { SlashCommand } from './types.js'
import { saveConversation, loadConversation } from './sessionStore.js'
import { resolveModelSelection, DEFAULT_PROVIDER_ID } from '@zuse/core'

/** 解析后的斜杠输入。null 表示"不是命令 —— 当作一条聊天消息处理"。 */
interface ParsedCommand {
  name: string
  args: string
}

const help: SlashCommand = {
  name: 'help',
  description: 'List available commands',
  run: ({ print }) => {
    const lines = COMMANDS.map((c) => `  /${c.name.padEnd(6)} ${c.description}`)
    print(['Available commands:', ...lines].join('\n'))
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
  description: 'Show the effective settings (merged from all layers)',
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
  description: 'Clear the conversation history',
  run: ({ clear, print }) => {
    clear()
    print('Conversation cleared.')
  },
}

const save: SlashCommand = {
  name: 'save',
  description: 'Save the conversation: /save <name>',
  run: async ({ args, conversation, print }) => {
    if (!args) {
      print('Usage: /save <name>')
      return
    }
    const path = await saveConversation(args, conversation)
    print(`Saved to ${path}`)
  },
}

const load: SlashCommand = {
  name: 'load',
  description: 'Load a saved conversation: /load <name>',
  run: async ({ args, load: replaceConversation, print }) => {
    if (!args) {
      print('Usage: /load <name>')
      return
    }
    const conv = await loadConversation(args)
    replaceConversation(conv)
    print(`Loaded "${args}" (${conv.length} messages).`)
  },
}

const model: SlashCommand = {
  name: 'model',
  description: 'List or switch model: /model [<provider/model>] [--save]',
  run: ({ args, settings, currentModel, currentProviderId, switchModel, print }) => {
    if (!args) {
      // 无参：列出所有可用模型，当前模型标星。
      const lines: string[] = ['可用模型（* = 当前）:']
      let starred = false
      for (const [id, p] of Object.entries(settings.providers)) {
        const models = p.models && p.models.length ? p.models : ['(未列出，可自由输入)']
        for (const m of models) {
          // provider + model 同时匹配才标星：重名模型（如多个 provider 都有 deepseek-v4-flash）
          // 下，只比模型名会把每个同名条目都标成当前，造成多个 *。
          const isCurrent = id === currentProviderId && m === currentModel
          if (isCurrent) starred = true
          lines.push(`  ${isCurrent ? '*' : ' '} ${id}/${m}`)
        }
      }
      if (Object.keys(settings.providers).length === 0) {
        lines.push(`  * default/${currentModel}`)
        lines.push('  (未配置 providers；当前用扁平配置的 default provider，可 /model <model> 换模型)')
      } else if (!starred) {
        // 当前模型不在任何已声明清单里（清单未收录的合法模型，或历史遗留的离群配置）。
        // 仍显式标出来，否则列表头写着「* = 当前」却一个星都没有，看不出当前用的是什么。
        lines.push(`  * ${currentProviderId}/${currentModel}  (当前；不在已声明列表中)`)
      }
      print(lines.join('\n'))
      return
    }
    // 有参：切换模型，可选 --save 写盘。
    const parts = args.split(/\s+/)
    const persist = parts.includes('--save')
    // 只取第一个非 --save 的 token 作为模型引用；模型名不含空格，
    // join(' ') 会把多余词拼进名字（如 "/model a/b note" → "b note"）造成切换失败。
    const ref = parts.find((x) => x !== '--save') ?? ''
    if (!ref) {
      print('Usage: /model <provider/model> [--save]')
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
    const declared = settings.providers[sel.providerId]?.models ?? []
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

/** 命令表。新增一个命令 = 在这里加一条（数据驱动）。 */
const COMMANDS: SlashCommand[] = [help, config, clear, save, load, model]

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
