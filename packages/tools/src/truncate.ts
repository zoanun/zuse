import { mkdirSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 输出整形(Feedback Shaping,Phase 9)—— 一次性大 blob 的 head+tail 截断。
 *
 * 适用对象是**不可寻址**的输出(Bash stdout、WebFetch 正文):没有行号/条目序可供
 * 续读,重跑代价高(副作用/网络往返)。策略 = 首尾各留一段(信号密度最高的两端)+
 * 中段省略;流式场景另支持把**完整输出落盘**,模型需要时用 Read/Grep(自带分页)
 * 去查 —— 把不可寻址转化成可寻址。
 *
 * 可寻址输出(Read 的行窗口、Grep 的 head_limit/offset、Glob 的条数上限)是另一
 * 策略:分页 + 续读指引,不归这里管(见 Phase 9 spec §2)。
 */

export interface ShapeOptions {
  /** 头部预算(字符)。 */
  headChars: number
  /** 尾部预算(字符);0 = 只留头(适合文章正文:尾部多为页脚杂讯)。 */
  tailChars: number
}

/** 行边界收口允许的最大让步:为对齐到换行最多放弃预算的 20%,否则按字符切。 */
const LINE_SNAP_RATIO = 0.8

/** 取 text 的前 budget 字符,行边界收口;让步过大(无换行/换行太靠前)则按字符切。 */
function cutHead(text: string, budget: number): string {
  const slice = text.slice(0, budget)
  if (slice.length < budget) return slice
  const nl = slice.lastIndexOf('\n')
  return nl >= budget * LINE_SNAP_RATIO ? slice.slice(0, nl) : slice
}

/** 取 text 的后 budget 字符,行边界收口;让步过大则按字符切。 */
function cutTail(text: string, budget: number): string {
  if (budget <= 0) return ''
  const slice = text.slice(-budget)
  if (slice.length < budget) return slice
  const nl = slice.indexOf('\n')
  return nl >= 0 && nl <= budget * (1 - LINE_SNAP_RATIO) ? slice.slice(nl + 1) : slice
}

function marker(
  totalChars: number,
  totalLines: number,
  headLen: number,
  tailLen: number,
  spillPath?: string,
): string {
  const shown =
    tailLen > 0 ? `showing first ${headLen} and last ${tailLen} chars` : `showing first ${headLen} chars`
  const spill = spillPath
    ? `. Full output: ${spillPath} — use Read or Grep (they paginate) to inspect it`
    : ''
  return `\n…[truncated: output was ${totalChars} chars / ${totalLines} lines; ${shown}${spill}]\n`
}

function countNewlines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++
  return n
}

/** 整段文本的 head+tail 塑形(WebFetch 等"拿到完整字符串再截"的场景)。 */
export function shapeHeadTail(
  text: string,
  opts: ShapeOptions,
): { body: string; truncated: boolean } {
  if (text.length <= opts.headChars + opts.tailChars) {
    return { body: text, truncated: false }
  }
  const head = cutHead(text, opts.headChars)
  const tail = cutTail(text, opts.tailChars)
  return {
    body: head + marker(text.length, countNewlines(text) + 1, head.length, tail.length) + tail,
    truncated: true,
  }
}

export interface StreamShaperOptions extends ShapeOptions {
  /** 全量落盘:目录 + 文件名前缀。省略则不落盘。dir 可注入,便于测试。 */
  spill?: { dir: string; prefix: string }
}

export interface ShapedResult {
  body: string
  truncated: boolean
  totalChars: number
  /** 完整输出的落盘路径;未截断/未配置/落盘失败时为 null。 */
  spillPath: string | null
}

/**
 * 流式 head+tail 塑形(Bash 用)。内存恒有界:head 只收前 headChars,tail 用字符串
 * 环形缓冲只留最后 tailChars —— 刷屏命令(yes、cat 大文件)不会把进程撑爆。
 *
 * 落盘时机:总量首次越过 headChars 即懒创建文件并补写已积累的全部内容(此刻
 * head 即全部历史,tail 环尚未丢过字符),此后逐 chunk 写穿 —— 文件 = 完整输出。
 * 必须在这一刻开,再晚 tail 环开始丢字符,文件就不全了。最终未触顶(总量 ≤
 * head+tail)则删掉白开的文件。落盘任何失败都优雅降级(照常截断,marker 不带
 * 路径):塑形不能因磁盘问题挂掉。
 */
export class StreamShaper {
  private head = ''
  private tail = ''
  private totalChars = 0
  private newlines = 0
  private fd: number | null = null
  private spillPath: string | null = null
  private spillFailed = false

  constructor(private readonly opts: StreamShaperOptions) {}

  append(text: string): void {
    if (text === '') return
    this.totalChars += text.length
    this.newlines += countNewlines(text)

    // 先分流进 head,溢出部分进 tail 环。
    let rest = text
    if (this.head.length < this.opts.headChars) {
      const take = Math.min(this.opts.headChars - this.head.length, rest.length)
      this.head += rest.slice(0, take)
      rest = rest.slice(take)
    }
    if (rest === '') return // 尚未溢出 head;将来首次溢出时 ensureSpill 会把 head 补写进文件。

    // 首次溢出 → 开 spill 并补写历史(head 已含本 chunk 的头部份额,tail 此刻为空);
    // 随后统一写本次溢出的 rest。此后 head 恒满 → rest === text,等于逐 chunk 写穿。
    this.ensureSpill()
    this.write(rest)

    if (this.opts.tailChars > 0) {
      this.tail = (this.tail + rest).slice(-this.opts.tailChars)
    }
  }

  finalize(): ShapedResult {
    const { headChars, tailChars } = this.opts
    if (this.totalChars <= headChars + tailChars) {
      // 未触顶:head+tail 即全文(tail 环没丢过字符)。提前开的 spill 白开了,删掉。
      this.closeSpill(true)
      return {
        body: this.head + this.tail,
        truncated: false,
        totalChars: this.totalChars,
        spillPath: null,
      }
    }
    this.closeSpill(false)
    const head = cutHead(this.head, headChars)
    const tail = cutTail(this.tail, tailChars)
    return {
      body:
        head +
        marker(this.totalChars, this.newlines + 1, head.length, tail.length, this.spillPath ?? undefined) +
        tail,
      truncated: true,
      totalChars: this.totalChars,
      spillPath: this.spillPath,
    }
  }

  /** 懒创建 spill 文件并补写历史(head+tail;本次溢出的 rest 由 append 随后写)。 */
  private ensureSpill(): void {
    if (this.fd !== null || this.spillFailed || !this.opts.spill) return
    try {
      mkdirSync(this.opts.spill.dir, { recursive: true })
      const name = `${this.opts.spill.prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
      const p = join(this.opts.spill.dir, name)
      this.fd = openSync(p, 'w')
      this.spillPath = p
    } catch {
      this.spillFailed = true
      return
    }
    // 首次溢出时 head 已含全部既往内容(含本 chunk 进 head 的份额),tail 恒为空。
    this.write(this.head)
    this.write(this.tail)
  }

  /** 写穿一段内容;失败则放弃整个 spill(关闭并删除半截文件),不让塑形挂掉。 */
  private write(text: string): void {
    if (this.fd === null || text === '') return
    try {
      writeSync(this.fd, text)
    } catch {
      this.abandonSpill()
    }
  }

  private abandonSpill(): void {
    this.closeSpill(true)
    this.spillFailed = true
  }

  private closeSpill(discard: boolean): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        /* 已尽力 */
      }
      this.fd = null
    }
    if (discard && this.spillPath) {
      try {
        unlinkSync(this.spillPath)
      } catch {
        /* 已尽力 */
      }
      this.spillPath = null
    }
  }
}
