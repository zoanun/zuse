import { isTurnOpener, type Message, type Part } from '../state/types.js'
import { replyMarkdown } from './Message.js'

/**
 * 精简视图：主画面只留「用户问的」和「模型最终答的」，中间过程（工具调用、模型在工具之间
 * 的碎碎念）不显示。
 *
 * ## 为什么正在跑的那一轮不过滤
 *
 * reducer 的真实行为是：`text-delta` / `tool-use` / `tool-result` 都**追加到最后一条**
 * assistant 消息上，然后 `message-start` 新建下一条。于是「本轮最后一条有正文的消息」
 * 在流式期间是**非单调**的 —— 模型先说一句话（用户已经读到了），再在同一条上追加工具调用，
 * 再开新消息；那一刻刚读到的正文当场从主画面消失、每调一次工具闪一次。
 *
 * 所以按「轮次是否已结束」分档：**在飞的那一轮全量显示，结束后才收拢**。
 * 这不只是回避 bug —— 跑的过程中你想看它在干什么，跑完只想看结论，本来就是人读东西的方式。
 * 而且过滤只在轮次终结那一刻发生一次，是稳定的收敛动作，不是逐 delta 的抖动。
 *
 * ## 为什么按部件而不是按消息
 *
 * 一条 assistant 消息的常态形状是 `[text, tool-use, tool-result]`（`foldToolResults` 把
 * 工具结果并进前一条消息）。按消息级过滤必然自相矛盾：想保住"最后一条有正文的消息"，
 * 就会把它挂着的工具卡片一起放回主画面。所以只取 text 部件。
 *
 * ## 兜底是规则自带的
 *
 * 取的是「最后一条**有正文的**」而不是「最后一条」。一轮若以纯工具消息收尾（被中断、
 * 工具收尾），自然回退到更早那条有正文的 —— 不会出现"用户问了但模型没回话"的空白轮次。
 *
 * @param thinking 最后一轮是否仍在跑。**必须传**：没有它，规则本身无法自洽（见上）。
 */
export function filterForCleanView(messages: Message[], thinking: boolean): Message[] {
  // 最后一个轮次开头的下标 —— thinking 时这一轮整段免过滤。
  let liveTurnStart = -1
  if (thinking) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isTurnOpener(messages[i]!)) { liveTurnStart = i; break }
    }
  }

  // 每个已结束轮次里「最后一条有正文的 assistant 消息」的下标集合。
  const keepAssistant = new Set<number>()
  let turnStart = 0
  const closeTurn = (endExclusive: number): void => {
    if (liveTurnStart >= 0 && turnStart === liveTurnStart) return   // 在飞那轮不参与
    for (let i = endExclusive - 1; i >= turnStart; i--) {
      const m = messages[i]!
      if (m.role === 'assistant' && replyMarkdown(m.parts) !== '') { keepAssistant.add(i); return }
    }
  }
  for (let i = 1; i < messages.length; i++) {
    if (!isTurnOpener(messages[i]!)) continue
    closeTurn(i)
    turnStart = i
  }
  closeTurn(messages.length)

  const out: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    // 在飞的那一轮：一个字不动。
    if (liveTurnStart >= 0 && i >= liveTurnStart) { out.push(m); continue }
    // 用户消息（含插话）与系统提示照常保留 —— 后者是「关于这次对话本身」的信息，
    // 不是模型的工作过程，收进抽屉等于把警告又藏起来。
    if (m.role !== 'assistant') { out.push(m); continue }
    if (!keepAssistant.has(i)) continue
    const textParts = m.parts.filter((p: Part) => p.kind === 'text')
    // 全是 text 时保持同一引用：Message 是 memo 的，重建对象会让它白白重渲染。
    out.push(textParts.length === m.parts.length ? m : { ...m, parts: textParts })
  }
  return out
}
