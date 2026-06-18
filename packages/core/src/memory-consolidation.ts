/**
 * 记忆自动巩固(Phase 13,轻量 autoDream)—— 纯函数层:门槛判定 / 提示词 / 解析。
 *
 * 对照:CC 的 autoDream 是四阶段子代理(自己 ls/读文件/写文件,≥24h 且 ≥5 会话);
 * OpenClaw 的 Dreaming 是三阶段 cron + 六维评分。zuse 取轻量版:单次无工具请求,
 * 模型读「全部记忆的清单」,输出 DELETE/SAVE 操作行,由 harness 确定性应用 ——
 * 不给巩固代理任何工具权限,出错面收敛到「解析不出操作 = 什么都不做」。
 *
 * 触发门槛(shouldConsolidateMemories):投影体积接近启动注入上限才值得整理
 * (太早整理是浪费请求),且距上次 ≥24h(防抖)。
 */

/** 距上次巩固的最小间隔。 */
export const CONSOLIDATION_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 投影体积超过注入上限的这个比例才触发(8k × 0.7 ≈ 5.6k)。 */
export const CONSOLIDATION_PRESSURE_RATIO = 0.7

/** 单次巩固最多删除的条数:解析层的安全帽,防一次坏输出清空记忆库。 */
export const CONSOLIDATION_MAX_DELETES = 20

/** 巩固输入的最小行形状(结构化定义在 tools 的 MemoryRow;core 不反向依赖)。 */
export interface ConsolidationMemory {
  id: number
  type: string
  content: string
  hook: string
  project: string
  createdAt: string
}

export interface ConsolidationOps {
  deletes: number[]
  saves: Array<{ type: 'user' | 'project' | 'insight' | 'reference'; hook: string; content: string }>
}

/**
 * 是否触发自动巩固。projectionChars = 当前 MEMORY.md 投影长度;
 * indexCap = 启动注入上限(MEMORY_INDEX_CAP);lastRunAt = 上次巩固时间(ISO,无则 null)。
 */
export function shouldConsolidateMemories(opts: {
  projectionChars: number
  indexCap: number
  lastRunAt: string | null
  now?: number
}): boolean {
  const now = opts.now ?? Date.now()
  if (opts.projectionChars < opts.indexCap * CONSOLIDATION_PRESSURE_RATIO) return false
  if (opts.lastRunAt) {
    const last = Date.parse(opts.lastRunAt)
    if (Number.isFinite(last) && now - last < CONSOLIDATION_MIN_INTERVAL_MS) return false
  }
  return true
}

/** 巩固请求的提示词:全量记忆清单 + 操作行协议。 */
export function buildConsolidationPrompt(memories: ConsolidationMemory[]): string {
  const lines = memories.map((m) => {
    const scope = m.project ? m.project : 'global'
    const hook = m.hook ? ` hook:${m.hook}` : ''
    return `[${m.id}] (${m.type}, ${scope}, ${m.createdAt.slice(0, 10)})${hook} content:${m.content}`
  })
  return (
    'Below is a long-term memory list for an AI assistant. Please tidy it up: ' +
    'merge duplicate or highly similar entries, remove outdated or contradictory entries, ' +
    'and make the list more concise. Rules:\n' +
    '- To delete an entry: output DELETE <id>\n' +
    '- To merge several entries into one new memory: first output the new entry as ' +
    'SAVE <type>|<one-line hook>|<full content>, then output DELETE <id> for each old entry being merged\n' +
    '- type must be one of user/project/insight/reference\n' +
    '- Do not output anything for entries that need no changes; if nothing needs tidying, output only NOOP\n' +
    '- When in doubt, keep the entry — be conservative\n' +
    'Output only operation lines, no explanations.\n\n' +
    '<memory_list>\n' +
    lines.join('\n') +
    '\n</memory_list>'
  )
}

/**
 * 解析巩固输出为操作集。格式不匹配的行忽略;DELETE 超过安全帽时**整体放弃**
 * (返回空操作)——一次输出敢删 20+ 条,大概率是模型跑飞了,宁可不动。
 */
export function parseConsolidationOps(text: string): ConsolidationOps {
  const deletes: number[] = []
  const saves: ConsolidationOps['saves'] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const del = /^DELETE\s+(\d+)$/.exec(line)
    if (del) {
      deletes.push(Number(del[1]))
      continue
    }
    const save = /^SAVE\s+(user|project|insight|reference)\s*\|([^|]*)\|(.+)$/.exec(line)
    if (save) {
      saves.push({
        type: save[1] as ConsolidationOps['saves'][number]['type'],
        hook: save[2]!.trim(),
        content: save[3]!.trim(),
      })
    }
  }
  if (deletes.length > CONSOLIDATION_MAX_DELETES) return { deletes: [], saves: [] }
  return { deletes: [...new Set(deletes)], saves }
}
