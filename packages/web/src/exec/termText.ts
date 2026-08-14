/**
 * 终端输出的文本处理（spec §4）。
 *
 * **实现已下沉到 `@zuse/protocol`**（步骤 5 落地 1b）。本文件只剩转出。
 *
 * 下沉的理由不是「整洁」：`RunOutput` 工具要把从有界缓冲里切出来的片段交给模型，
 * 而右栏吃的是 SSE 的增量 chunk —— 两边必须用**同一份规则**，否则会出现
 * 「同一次运行，右栏和模型看到的文本不一样」，而排查时没人会先怀疑净化规则。
 *
 * 本文件保留这个入口是因为 `termText.test.ts` 的 9 条用例挂在这里 ——
 * 它们现在同时充当「下沉之后行为一字未变」的回归证据。
 */
export { TermBuffer, sanitizeTerminalText } from '@zuse/protocol'
