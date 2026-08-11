import { isTurnOpener, type Message, type Part } from '../state/types.js'
import { replyMarkdown } from './Message.js'

/** 一轮的中间步骤（抽屉里的一页 / tab 条里的一格）。 */
export interface TurnSteps {
  /** 该轮**用户提问**那条消息的 id —— 点 tab 时主画面滚到这里（不是滚到回复）。 */
  turnId: string
  /** 轮次序号（1 起）。是**轮次**的序号而不是 tab 的下标：第 3 轮就显示 3，
   *  哪怕第 2 轮没有步骤、不出 tab —— 否则点开跟主画面对不上号。 */
  index: number
  /** tab 上的短标签：提问的前若干字。纯序号认不出是哪一轮。 */
  label: string
  /** 按**时间顺序**混排的步骤。抽屉要回答「这一轮到底发生了什么」，按类型分堆会打乱因果。 */
  parts: { msgId: string; part: Part }[]
}

/** tab 标签取提问的前几个字。太长会把竖条撑宽，太短认不出来。 */
const LABEL_CAP = 12

/**
 * 按轮次抽出「中间步骤」= 主画面精简后被收走的那些东西：工具调用、工具结果、
 * 以及不是最终回答的那些正文。
 *
 * **与 `filterForCleanView` 共用同一条判据**（「该轮最后一条有正文的 assistant 消息」
 * 留在主画面，其余是步骤），但**刻意不共用「在飞轮次免过滤」那一条**：
 *
 * 主画面对在飞的那一轮全量显示（防止读到一半的正文消失，见 cleanView.ts）；
 * 而抽屉必须**从第一次工具调用起就有内容**，否则「默认显示当前轮的中间步骤」这个诉求
 * 在最需要它的时刻（正在跑）恰好是空的。
 *
 * 代价：流式期间同一份工具卡片在主画面和抽屉里各有一份。**接受** —— 它只持续到本轮结束，
 * 而且此时两处都在讲同一件正在发生的事，并不矛盾。轮次一结束主画面就收拢，抽屉成为唯一去处。
 *
 * 只返回**真有步骤**的轮次：一轮若没调过工具、也没有中间正文，它没有"中间内容"，
 * 给它出一个点开是空的 tab 属于骗人。
 */
export function turnStepsOf(messages: Message[]): TurnSteps[] {
  const out: TurnSteps[] = []
  let turnIndex = 0
  let i = 0
  while (i < messages.length) {
    if (!isTurnOpener(messages[i]!)) { i++; continue }
    turnIndex++
    const start = i
    let end = start + 1
    while (end < messages.length && !isTurnOpener(messages[end]!)) end++

    // 主画面留的那条（= 本轮最后一条有正文的 assistant），它的正文不算步骤。
    let keptIdx = -1
    for (let k = end - 1; k >= start; k--) {
      const m = messages[k]!
      if (m.role === 'assistant' && replyMarkdown(m.parts) !== '') { keptIdx = k; break }
    }

    const parts: { msgId: string; part: Part }[] = []
    for (let k = start; k < end; k++) {
      const m = messages[k]!
      if (m.role !== 'assistant') continue    // 用户提问 / 插话 / 系统提示都留在主画面
      for (const part of m.parts) {
        if (part.kind === 'text' && k === keptIdx) continue   // 最终回答在主画面
        parts.push({ msgId: m.id, part })
      }
    }

    if (parts.length > 0) {
      const opener = messages[start]!
      const raw = opener.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text).join(' ').trim()
      const label = raw.length > LABEL_CAP ? raw.slice(0, LABEL_CAP) + '…' : (raw || '（无标题）')
      out.push({ turnId: opener.id, index: turnIndex, label, parts })
    }
    i = end
  }
  return out
}
