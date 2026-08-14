/**
 * 从一条流的持有区间里切一段出来 —— `RunOutput` 工具的取数核心（步骤 5 §5.3/§5.5）。
 *
 * **纯函数、无状态。** 服务端不记「模型读到哪儿了」（§5 的核心取舍：记了模型就再也
 * 回不去重读）。游标由模型自己带回来，所以这里每次都要独立地把边界算对。
 *
 * ## 坐标系是**原始（未净化）字符**
 *
 * 先按原始 offset 切片，再净化。净化会让字符数变少，所以「本次给了 [a,b)」里的 b-a
 * 与模型看到的文本长度对不上 —— 那是正常的，要在提示语里说清。
 * 游标必须锚在服务端真实持有的那份上，否则两侧永远对不齐。
 */

/**
 * 一条**没写完**的转义序列。
 *
 * `\[` 是可选的：切点可能正好落在 `\x1b` 与 `[` 之间，那时手上只有一个孤零零的 ESC。
 * 这与 `@zuse/protocol` 的 `ANSI_TAIL` 是同一个形状 —— 两处都在回答
 * 「末尾这截是不是一条还没结束的序列」。
 */
const CSI_OPEN = /\x1b(?:\[[0-9;?]*[ -/]*)?$/

/**
 * 往回找一个有界距离，看 `at` 是不是落在一条 CSI 中间。返回序列起点，没有则 -1。
 *
 * **有界**（64 字符）是刻意的：CSI 很短，扫全串会让长输出上的每次读取都 O(n)。
 */
function csiStartCovering(text: string, at: number): number {
  const from = Math.max(0, at - 64)
  const head = text.slice(from, at)
  const m = CSI_OPEN.exec(head)
  return m ? from + m.index : -1
}

/**
 * 从序列起点 `s` 找它的结束字符，返回结束字符的下标；没结束则 -1。
 *
 * **必须跳过 `\x1b[` 这两个字节再开始找。** CSI 的结束字节是 0x40–0x7E，
 * 而 `[` 本身就是 **0x5B**，落在那个区间里 —— 从 `s` 起扫会立刻「找到」那个 `[`
 * 并把它当成序列结束。我第一版就是这么写的，三条用例当场红
 *（`\x1b[31mRED` 被切成 `31mRED`，正是这条规则要防的事）。
 */
function csiEndIndex(text: string, s: number): number {
  let i = s + 2                                   // 跳过 ESC 与 '['
  while (i < text.length) {
    const c = text.charCodeAt(i)
    if (c >= 0x40 && c <= 0x7e) return i
    i++
  }
  return -1
}

export interface SliceInput {
  /** 服务端持有的原始文本（sink 的快照）。 */
  text: string
  /** `text[0]` 在整条流里的原始下标。 */
  firstChar: number
  /** 这条流**实际产生**过的总字符数。 */
  totalChars: number
  /** 模型给的起点。负数 = 从末尾往前数；超界一律归一，不报错。 */
  since: number
  /** 本次最多给多少原始字符。 */
  limit: number
  /** 进程是否已经结束 —— 决定末尾半截序列是丢弃还是留到下次。 */
  ended: boolean
}

export interface SliceResult {
  /** 本次切出的**原始**片段（尚未净化）。 */
  raw: string
  /** 本次实际给的区间起点（可能因规则 (c) 前推）。 */
  from: number
  /** 下次该从哪儿接着读。**必须落在安全边界上**。 */
  nextSince: number
  /** 起点之前有多少字符是**永远拿不到**的（被 sink 丢掉了）。 */
  droppedBefore: number
}

/**
 * 三条边界规则，每条都有实测反例支撑（见 spec §5.5）：
 *
 * **(a) 右边界收回**：`[a,b)` 的 b 落在一条 CSI 中间 → 把 b 收回到序列开头，
 * 下一段正好从序列头接上。不收的话切出 `\x1b[3`，净化时它是「半截」被丢，
 * 而下一段的 `1m` 会当正文漏出来。
 *
 * **(b) 退化时前伸**：收回导致 `b == a`（这一段整个就是一条超长序列的开头）→
 * 反向前伸到**序列结束、或可给区间末尾，取先到者**。
 * 「或可给区间末尾」不能漏：**进程可以死在半截序列上**（最后三个字符就是 `\x1b[3`，
 * 之后再也不会有输出）。写成「前伸到序列结束」而序列没结束时，游标永远停在原地、
 * 尾部提示永远说「还有 3 字符未读」，**模型对着一个已 exited 的 run 无限轮询**。
 *
 * **(c) 起点往回看，不要猜**。起点由归纳法保证在边界上（我们只发安全的 nextSince），
 * 但模型可以传任意负数，归纳链就断了。所以往回扫一个有界距离找 `\x1b`；
 * 找到且它的序列跨过了 a，就把 a **前推到序列结束**。
 *
 * **绝不能反过来「把开头那截孤儿序列尾巴剥掉」** —— 那条会大面积误删正文。
 * 孤儿尾巴从切片本身不可识别（`31m` 和 `main` 在无状态的眼里一模一样），
 * 唯一能写的判据 `^[0-9;?]*[ -/]*[@-~]` 里 `[@-~]` 囊括全部字母，实测 6/7 的正常文本
 * 会被吃掉第一个字符：`Traceback` → `raceback`。少一个字母 review 时几乎看不出来，
 * 而模型会对着被篡改的第一行做推断。
 */
export function sliceStream(input: SliceInput): SliceResult {
  const { text, firstChar, totalChars, limit, ended } = input
  const held = text.length
  const heldEnd = firstChar + held

  // 负数 = 从末尾往前数；超界归一到 0（不报错，§5.3）。
  let a = input.since < 0 ? Math.max(0, totalChars + input.since) : input.since
  // 起点落在已被丢弃的区间里 → 只能从我们还持有的地方开始。
  const droppedBefore = Math.max(0, firstChar - a)
  if (a < firstChar) a = firstChar
  if (a > heldEnd) a = heldEnd

  let b = Math.min(heldEnd, a + Math.max(0, limit))

  // (c) 起点归位：a 落在一条 CSI 中间 → 前推到序列结束。
  if (a > firstChar && a < heldEnd) {
    const s = csiStartCovering(text, a - firstChar)
    if (s >= 0) {
      const e = csiEndIndex(text, s)
      if (e >= 0) a = firstChar + e + 1          // 序列在持有区间里结束了 → 跳过它
      // 没结束就不动 a —— 那说明整段都还在序列里，交给 (b) 处理。
      if (a > b) b = Math.min(heldEnd, a + Math.max(0, limit))
    }
  }

  // (a) 右边界收回：b 落在一条 CSI 中间 → 收回到序列开头。
  if (b > a && b < heldEnd) {
    const s = csiStartCovering(text, b - firstChar)
    if (s >= 0) {
      const pulled = firstChar + s
      // (b) 收回会导致空区间 → 前伸到序列结束或可给区间末尾，取先到者。
      if (pulled <= a) {
        const e = csiEndIndex(text, s)
        b = e >= 0 ? firstChar + e + 1 : heldEnd
      } else {
        b = pulled
      }
    }
  }

  // 进程结束了，末尾挂着的半截序列不会再有下文 —— 直接消费掉，否则游标永远停在这儿，
  // 模型会对着一个已 exited 的 run 无限轮询。
  if (ended && b < heldEnd && b === a) b = heldEnd

  return {
    raw: text.slice(a - firstChar, b - firstChar),
    from: a,
    nextSince: b,
    droppedBefore,
  }
}

/**
 * `both` 档的额度分配（§5.4）：**小的那条永远给全，大的那条吃剩余额度**，
 * 两条都大时对半分。
 *
 * 理由：stderr 通常很短而信息密度最高（traceback 就在那），让它被 stdout 挤掉
 * 是最坏的结果。
 */
export function splitBudget(wantOut: number, wantErr: number, cap: number): { out: number; err: number } {
  if (wantOut + wantErr <= cap) return { out: wantOut, err: wantErr }
  const half = Math.floor(cap / 2)
  if (wantErr <= half) return { out: cap - wantErr, err: wantErr }
  if (wantOut <= half) return { out: wantOut, err: cap - wantOut }
  return { out: half, err: cap - half }
}
