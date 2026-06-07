/**
 * 历史滚动的纯逻辑核心：估算每条消息占用的终端行数，并按「行」开窗。
 * 抽成不依赖 React/ink 的纯函数便于单测，组件壳只负责按键分发与渲染
 *（与 selectList.ts / inputKeymap.ts 把核心逻辑抽出来单测同一套路）。
 *
 * 为什么按「行」而非按「条」开窗：聊天消息高矮不一（一行的工具调用 vs 几十行的
 * 助手长回复），按条数开窗会让视口实际高度忽高忽低、还可能把单条长消息撑爆终端。
 * 按行开窗才能让渲染高度稳定贴住视口（也顺带规避 Ink 在输出超过终端高度时的重绘问题）。
 */
import type { UIMessage } from '../types.js'

/**
 * 估算一条消息渲染后占用的终端行数（含边框/下边距）。
 * 不求精确（流式增量、富渲染会有偏差），只求够稳：宁可略高于实际——
 * 留白比缺行好（窗口少显示一两条远比把内容截没了可接受）。
 */
export function estimateMessageRows(msg: UIMessage, columns: number): number {
  const cols = Math.max(1, columns)
  // 文本软换行估算：先按硬换行切段，每段再按列宽折行求和。
  const wrapped = (text: string): number => {
    if (text === '') return 0
    return text
      .split('\n')
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / cols)), 0)
  }

  if (msg.role === 'tool' && msg.tool) {
    // 工具块：一行标题 + 可选一行输出预览（完成且有输出时）+ 1 行下边距。
    const preview = msg.tool.status === 'done' && msg.tool.output ? 1 : 0
    return 1 + preview + 1
  }
  if (msg.role === 'system') {
    // 暗色通知：文本 + 1 行下边距。
    return Math.max(1, wrapped(msg.text)) + 1
  }
  if (msg.role === 'user') {
    // 圆角边框上下各 1 行 + 文本 + 1 行下边距。
    return Math.max(1, wrapped(msg.text)) + 2 + 1
  }
  // assistant：纯工具回合（无文本且非流式）渲染成 null，占 0 行（与 StreamRenderer 对齐）。
  if (!msg.isStreaming && msg.text === '') return 0
  // 文本 + 可选一行 usage + 1 行下边距。
  return Math.max(1, wrapped(msg.text)) + (msg.usage ? 1 : 0) + 1
}

export interface HistoryWindow {
  /** 可视消息切片下标 [start, end)（end 不含）。 */
  start: number
  end: number
  /** 视口上方被裁掉的消息条数（用于渲染「↑ N 条更早」）。 */
  hiddenAbove: number
  /** 视口下方被裁掉的消息条数（用于渲染「↓ N 条更新」）。 */
  hiddenBelow: number
  /** 允许的最大上滚行数（offsetRows 的上界）= max(0, 总行数 - 视口行数)。 */
  maxOffsetRows: number
}

/**
 * 按行开窗：以底部为基准，向上量 offsetRows 行作为视口底。
 * offsetRows = 0 表示贴底（看最新）；增大则向上滚动看更早的内容。
 * rows[i] 为第 i 条消息的估算行数（见 estimateMessageRows）。
 * offsetRows 超界会被夹到 [0, maxOffsetRows]，故上层存原始值、由本函数兜底夹取即可。
 */
export function computeHistoryWindow(
  rows: number[],
  viewportRows: number,
  offsetRows: number,
): HistoryWindow {
  const n = rows.length
  const vh = Math.max(1, viewportRows)
  // 前缀和：prefix[i] = 前 i 条消息累计行数；prefix[n] = 总行数。
  const prefix = new Array<number>(n + 1)
  prefix[0] = 0
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + Math.max(0, rows[i]!)
  const total = prefix[n]!

  const maxOffsetRows = Math.max(0, total - vh)
  const off = Math.max(0, Math.min(offsetRows, maxOffsetRows))
  // 视口覆盖的行区间 [topRow, botRow)。
  const botRow = total - off
  const topRow = Math.max(0, botRow - vh)

  // 取与 [topRow, botRow) 相交的消息：消息 i 占行区间 [prefix[i], prefix[i+1])。
  let start = n
  let end = 0
  for (let i = 0; i < n; i++) {
    const a = prefix[i]!
    const b = prefix[i + 1]!
    if (b > a && b > topRow && a < botRow) {
      if (i < start) start = i
      if (i + 1 > end) end = i + 1
    }
  }
  if (start > end) {
    // 空列表或全是零高消息：给一个空窗。
    start = n
    end = n
  }

  // 统计完全落在视口外的消息条数（零高消息不计，它们本就不渲染内容）。
  let hiddenAbove = 0
  let hiddenBelow = 0
  for (let i = 0; i < n; i++) {
    if (rows[i]! <= 0) continue
    if (prefix[i + 1]! <= topRow) hiddenAbove++
    else if (prefix[i]! >= botRow) hiddenBelow++
  }

  return { start, end, hiddenAbove, hiddenBelow, maxOffsetRows }
}

/** 把上滚行数夹到 [0, max]。供按键处理器在 setState 里复用。 */
export function clampOffsetRows(offsetRows: number, maxOffsetRows: number): number {
  return Math.max(0, Math.min(offsetRows, Math.max(0, maxOffsetRows)))
}
