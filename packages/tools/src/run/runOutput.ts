import type { Tool, ToolResult, JSONSchema } from '@zuse/core'
import { sanitizeTerminalText } from '@zuse/protocol'
import { sliceStream, splitBudget } from './slice.js'
import type { RunRegistry } from './registry.js'

/** 单次总上限。连续一段，不做 Bash 那种 head/tail 两段式（有游标时中间挖块说不清 since 该给什么）。 */
const CAP = 30_000

export interface RunOutputDeps {
  registry: RunRegistry
  /** **本会话**的 id。会话隔离靠它，见 run() 里那段。 */
  sessionId: string
}

interface RunOutputInput {
  runId?: unknown
  since?: unknown
  stream?: unknown
}

const inputSchema: JSONSchema = {
  type: 'object',
  properties: {
    runId: { type: 'string', description: 'The run to read. Omit to list this session\'s runs.' },
    stream: {
      type: 'string', enum: ['out', 'err', 'both'],
      description: 'Which stream to read. Default: both.',
    },
    since: {
      type: 'number',
      description:
        'Start offset in RAW characters. Negative = last N characters (the common case: ' +
        '"what did it print at the end"). Omit to start from the beginning. ' +
        'Pass back the nextSince value from a previous call to continue reading.',
    },
  },
}

/** 每流各自的游标：数字 = 两条流都用它；对象 = 逐流精确。 */
function sinceFor(raw: unknown, stream: 'out' | 'err'): number {
  if (typeof raw === 'number') return raw
  if (raw && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>)[stream]
    if (typeof v === 'number') return v
  }
  return 0
}

/**
 * `RunOutput` —— 让模型读它自己起的那些后台命令的输出。
 *
 * ## 为什么是只读的、且不带 stop
 *
 * 停一个 run 会破坏 `readOnly: true`，而且「模型停掉用户正盯着的 dev server」
 * 是真实的意外行为。停留给用户，见 spec §9。
 *
 * ## 会话隔离
 *
 * 别的会话的 runId 一律报「没有这个运行」，**不报「无权访问」** ——
 * 后者会把「别的会话存在一个 id 为 X 的 run」这个事实泄露给模型，
 * 而模型的输出会进用户的聊天记录。被淘汰掉的 run 落同一句，语义无歧义。
 */
export function createRunOutputTool(deps: RunOutputDeps): Tool {
  return {
    name: 'RunOutput',
    description:
      'Read output from background commands started in this session (dev servers, builds, scripts). ' +
      'Call with no runId to list them. Output is returned in chunks: pass back nextSince to continue. ' +
      'Use a negative since (e.g. -5000) to read the tail — usually what you want when checking for errors.',
    inputSchema,
    // 只读：不起进程、不改文件、不停任何东西。
    readOnly: true,
    parallelizable: true,
    // **会话级**：它绑的是创建它的那个会话的 run 注册视图，绝不能进子代理的注册表。
    sessionScoped: true,

    async run(rawInput: unknown): Promise<ToolResult> {
      const input = (rawInput ?? {}) as RunOutputInput
      const runId = typeof input.runId === 'string' ? input.runId : null

      if (!runId) {
        const rows = deps.registry.list().filter((r) => r.sessionId === deps.sessionId)
        if (rows.length === 0) {
          return { output: '本会话还没有起过后台命令。', isError: false }
        }
        const lines = rows.map((r) => {
          const what = r.label ?? r.command
          const code = r.exitCode === null ? '' : `，退出码 ${r.exitCode}`
          const orphan = r.orphaned ? '（它启动的东西可能还在后台跑）' : ''
          return `- ${r.id}  [${r.status}${code}] ${what}${orphan}`
        })
        return { output: `本会话的后台命令：\n${lines.join('\n')}`, isError: false }
      }

      const run = deps.registry.get(runId)
      // 归属校验与「不存在」走同一句 —— 见函数注释。
      if (!run || run.sessionId !== deps.sessionId) {
        return { output: `没有这个运行：${runId}`, isError: true }
      }

      const which = input.stream === 'out' || input.stream === 'err' ? input.stream : 'both'
      const ended = run.status === 'exited' || run.status === 'zombie'

      const streams: Array<'out' | 'err'> = which === 'both' ? ['out', 'err'] : [which]
      // 先看两条各自想要多少，再分额度：小的那条永远给全（stderr 通常最短、信息密度最高）。
      const wants = streams.map((s) => {
        const r = run.read(s)
        const from = sinceFor(input.since, s)
        const start = from < 0 ? Math.max(0, r.totalChars + from) : Math.max(from, r.firstChar)
        return Math.max(0, r.firstChar + r.text.length - start)
      })
      const budget = streams.length === 2
        ? splitBudget(wants[0]!, wants[1]!, CAP)
        : { out: CAP, err: CAP }

      const parts: string[] = []
      const nextSince: Record<string, number> = {}
      for (const s of streams) {
        const r = run.read(s)
        const limit = streams.length === 2 ? (s === 'out' ? budget.out : budget.err) : CAP
        const sl = sliceStream({
          text: r.text, firstChar: r.firstChar, totalChars: r.totalChars,
          since: sinceFor(input.since, s), limit, ended,
        })
        nextSince[s] = sl.nextSince
        const body = sanitizeTerminalText(sl.raw)
        const head = `--- ${s === 'out' ? 'stdout' : 'stderr'} ---`
        const notes: string[] = []
        if (sl.droppedBefore > 0) notes.push(`（开头 ${sl.droppedBefore} 字符已被丢弃，读不到了）`)
        const remaining = r.totalChars - sl.nextSince
        if (remaining > 0) notes.push(`（还有 ${remaining} 字符未读，把 nextSince 传回来继续）`)
        parts.push(`${head}${notes.join('')}\n${body || '（暂无新输出）'}`)
      }

      const status = ended
        ? `已结束（${run.endReason ?? 'exit'}${run.exitCode === null ? '' : `，退出码 ${run.exitCode}`}）`
        : '仍在运行'
      // 净化会让字符数变少，所以「本次给了 [a,b)」与文本长度对不上 —— 说清，免得模型犯嘀咕。
      const tail = `\n\n状态：${status}。nextSince=${JSON.stringify(nextSince)}` +
        `（这是**原始**字符偏移；上面的文本经过了终端净化，长度会更短，这是正常的）`
      return { output: parts.join('\n\n') + tail, isError: false }
    },
  }
}
