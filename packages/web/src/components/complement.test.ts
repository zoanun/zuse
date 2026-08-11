import { describe, expect, it } from 'vitest'
import { filterForCleanView } from './cleanView.js'
import { turnStepsOf } from './turnSteps.js'
import type { Message } from '../state/types.js'

/**
 * **主画面留下的部件 + 抽屉收走的部件 = 原始部件全集。** 这一条不成立时的症状是
 * 某个部件**两边都不出现** —— 工具调用在界面上彻底消失，而用户根本不知道自己少看了什么。
 *
 * `filterForCleanView` 与 `turnStepsOf` 是两个独立函数，各自决定"留什么/收什么"。
 * 只要它们的判据有一丝错位，就会漏出这种黑洞。所以这一组用例专门喂**畸形形状**：
 * 各自那两个测试文件里的用例都是规整对话，规整输入照不出边界上的错位 ——
 * 事实上 P1/P2/P6 三条一开始就是红的，`turnStepsOf` 会把第一条用户提问之前的
 * 消息整段跳过（`while` 循环遇到非 opener 就 `i++; continue`）。
 *
 * 加新形状时只要往下面接一个 `shape(...)` 即可，不用想"该断言什么"——断言只有这一条。
 *
 * ## 这条护栏照不到的地方（评审指出，写在这里省掉后来人一次误判）
 *
 * 它数的是**部件的个数**，不是"渲染得出来"。下面 system / steer 那两条之所以绿，
 * 是因为 `filterForCleanView` 把非 assistant 消息**整条**放进主画面、计数就算数上了；
 * 但 `Message.tsx` 渲染 `role:'system'` / `role:'user'` 时走的是 `partsText()`，
 * 而那个函数只拼 text 部件、**静默丢掉工具部件**。所以这两种形状真出现的话，
 * 界面上依然是黑洞，这里照样是绿的。
 *
 * 现在不修，是因为投影层不产出这种消息（`SessionManager.projectMessages()`）。
 * 哪天真出现了，要改的是 `Message.tsx` 的渲染，不是这里的判据。
 */
const user = (id: string, text: string): Message => ({ id, role: 'user', parts: [{ kind: 'text', text }] })
const steer = (id: string, text: string): Message => ({ id, role: 'user', steer: true, parts: [{ kind: 'text', text }] })
const asst = (id: string, parts: Message['parts']): Message => ({ id, role: 'assistant', parts })
const txt = (text: string) => ({ kind: 'text' as const, text })
const tool = (id: string) => ([
  { kind: 'tool-use' as const, id, name: 'Bash', input: {} },
  { kind: 'tool-result' as const, id, name: 'Bash', output: 'o', isError: false },
])

/** 每个形状的唯一断言：不丢不重。 */
function shape(name: string, msgs: Message[]): void {
  it(name, () => {
    const total = msgs.reduce((n, m) => n + m.parts.length, 0)
    const inMain = filterForCleanView(msgs).reduce((n, m) => n + m.parts.length, 0)
    const inDrawer = turnStepsOf(msgs).reduce((n, t) => n + t.parts.length, 0)
    expect({ inMain: inMain + inDrawer, total }).toEqual({ inMain: total, total })
  })
}

describe('主画面与抽屉的互补性：没有任何部件两边都不出现', () => {
  shape('规整对话：提问 + 带工具的回复 + 最终回答', [
    user('u1', '问题'), asst('a1', [txt('中间'), ...tool('t1')]), asst('a2', [txt('答')]),
  ])

  // ── 下面三条一开始是红的，暴露了 turnStepsOf 跳过"不属于任何轮次"的消息 ──
  shape('第一条提问之前的纯工具 assistant 消息', [
    asst('a0', tool('t0')), user('u1', '问题'), asst('a1', [txt('答')]),
  ])

  shape('第一条提问之前的 assistant 带正文 + 工具', [
    asst('a0', [txt('开场白'), ...tool('t0')]), user('u1', '问题'), asst('a1', [txt('答')]),
  ])

  shape('整个数组里一条轮次起点都没有（全是插话）', [
    steer('s0', '插话'), asst('a1', [txt('好'), ...tool('t1')]),
  ])

  // ── 下面这些一开始就是绿的，留着防回归 ──
  shape('system 消息带工具部件（系统提示整条留在主画面）', [
    user('u1', '问题'),
    { id: 's1', role: 'system', parts: [txt('n'), ...tool('t1')], noticeKind: 'warn' },
  ])

  shape('插话(steer) 的 user 消息带工具部件', [
    user('u1', '问题'),
    { id: 's1', role: 'user', steer: true, parts: [txt('等下'), ...tool('t1')] },
  ])

  shape('一条消息内 text / tool 交错多次', [
    user('u1', '问题'),
    asst('a1', [txt('T1'), ...tool('x1'), txt('T2'), ...tool('x2')]),
  ])

  shape('空数组', [])

  shape('只有一条纯工具 assistant 消息', [asst('a0', tool('t0'))])
})
