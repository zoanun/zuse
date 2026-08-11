import { isTurnOpener, type Message, type Part } from '../state/types.js'

/** 一轮的中间步骤（抽屉里的一页 / tab 条里的一格）。 */
export interface TurnSteps {
  /** 该轮**用户提问**那条消息的 id —— 点 tab 时主画面滚到这里（不是滚到回复）。 */
  turnId: string
  /** 轮次序号（1 起）。是**轮次**的序号而不是列表下标：第 3 轮就显示 3，
   *  哪怕第 2 轮没有步骤、不出现 —— 否则点开跟主画面对不上号。
   *  **0 = 不属于任何轮次**（排在第一条用户提问之前的那一段），UI 上显示为「·」。 */
  index: number
  /** tab 上的短标签：提问的前若干字。纯序号认不出是哪一轮。 */
  label: string
  /** 按**时间顺序**混排的步骤。抽屉要回答「这一轮到底发生了什么」，按类型分堆会打乱因果。 */
  parts: { msgId: string; part: Part }[]
}

/**
 * tab 标签取提问的前几个字。
 *
 * 12 是**竖排文字**时代的遗留上限（`writing-mode: vertical-rl`，一格只有 40px 宽）。
 * 改横排后一行有 300px 左右，放得下更多字；而连续追问常常前几个字一模一样
 * （「你给第一个改成全部完成」/「第二个，也改成全部完成」），截太短就认不出是哪一轮。
 */
const LABEL_CAP = 20

/**
 * 按轮次抽出「中间步骤」= 主画面精简后被收走的东西。
 *
 * **判据与 `filterForCleanView` 严格互补**：那边留下全部 `text` 部件，这边收走全部
 * 非 text 部件（tool-use / tool-result）。两者合起来正好是原始部件全集，
 * 一个不多、一个不少 —— 有 cleanView.test.ts 里的"不丢不重"那条钉着。
 *
 * 上一版两边各写了一套「本轮最后一条有正文的 assistant」判据（同一段逻辑抄两遍），
 * 那是信息黑洞的温床：判据一漂移，某个部件就会**两边都没有**、在界面上彻底消失。
 * 现在的分法不需要任何判断，也就没有漂移的余地。
 *
 * ## 「随便说几句话不该冒出一堆 tab」是这条分法自带的
 *
 * 纯聊天的轮次（没调过工具）非 text 部件为零 → `parts` 为空 → **不出 tab**。
 * 不需要额外的"简单轮次"启发式，也就不用承担"判简单了就把内容藏没"的风险。
 * 只有真的调过工具的轮次才占一格，而那一格里确实有东西可看。
 *
 * ## 为什么在飞的那一轮也照收
 *
 * 抽屉必须**从第一次工具调用起就有内容**，否则「默认显示当前轮的中间步骤」这个诉求
 * 在最需要它的时刻（正在跑）恰好是空的。这里不存在上一版那个"流式期间两边各一份"的
 * 重复问题了 —— 工具卡片任何时候都只在抽屉里，主画面从头到尾都没有它。
 */
export function turnStepsOf(messages: Message[]): TurnSteps[] {
  const out: TurnSteps[] = []
  let turnIndex = 0
  let i = 0
  while (i < messages.length) {
    const start = i
    // **不跳过任何消息。** 上一版这里是 `if (!isTurnOpener(...)) { i++; continue }`，
    // 于是「第一条用户提问**之前**」的 assistant 消息（会话开头的形状、revert 掉开头的
    // 提问、快照恢复时的怪形状、整个数组全是 steer）连同它们的工具调用被整段跳过 ——
    // 而主画面那边照常把工具部件过滤掉，结果就是**两边都没有**、在界面上彻底消失。
    // 这正是「不丢不重」那条护栏要防的事，但护栏当时只喂了规整输入，没照出来。
    // 现在的写法把数组切成连续的段，段的起点不一定是 turn opener，一个部件也漏不掉。
    const opened = isTurnOpener(messages[start]!)
    if (opened) turnIndex++      // 只有真轮次才推进序号；开头那段挂 0，UI 上显示为「·」
    let end = start + 1
    while (end < messages.length && !isTurnOpener(messages[end]!)) end++

    const parts: { msgId: string; part: Part }[] = []
    for (let k = start; k < end; k++) {
      const m = messages[k]!
      if (m.role !== 'assistant') continue    // 用户提问 / 插话 / 系统提示都留在主画面
      for (const part of m.parts) {
        if (part.kind === 'text') continue    // 正文一律留在主画面（见 cleanView.ts）
        parts.push({ msgId: m.id, part })
      }
    }

    if (parts.length > 0) {
      const anchor = messages[start]!
      const raw = anchor.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text).join(' ').trim()
      const fallback = opened ? '（无标题）' : '（会话开头）'
      const label = raw.length > LABEL_CAP ? raw.slice(0, LABEL_CAP) + '…' : (raw || fallback)
      out.push({ turnId: anchor.id, index: turnIndex, label, parts })
    }
    i = end
  }
  return out
}
