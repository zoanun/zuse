import { randomUUID } from 'node:crypto'
import type { Message, Usage } from './types.js'
import { emptyUsage } from './types.js'

/** 新消息的随机稳定 id。 */
export function genMsgId(): string {
  return `msg_${randomUUID()}`
}

/** 用于 /save 和 /load 的序列化形式（Phase 2.7）。version 为将来的迁移留出闸门。 */
export interface ConversationSnapshot {
  version: 1
  messages: Message[]
  totalUsage: Usage
}

/**
 * Conversation —— 已提交会话历史的权威存储。
 * 这正是每个回合重新发给模型的内容（无状态服务端）。
 *
 * 纯数据 + 操作，不含 React。TUI 在 ref 里持有一个实例，并把一份
 * 适合渲染的视图镜像到组件 state 中。
 */
export class Conversation {
  private messages: Message[] = []
  private _totalUsage: Usage = emptyUsage()

  append(message: Message): void {
    if (!message.id) throw new Error('Conversation.append: Message missing id')
    this.messages.push(message)
  }

  appendUserText(text: string): void {
    this.append({ role: 'user', id: genMsgId(), content: [{ type: 'text', text }] })
  }

  appendAssistantText(text: string): void {
    this.append({ role: 'assistant', id: genMsgId(), content: [{ type: 'text', text }] })
  }

  /**
   * 返回一份**深**拷贝 —— 调用方可随意读写结果(含每个 content block 及其 input 对象),
   * 绝不会污染我们内部的消息/内容块。浅拷贝只护住数组、block 仍是共享引用,改 block.input
   * 会回灌内部状态,故用 structuredClone 整体深拷。getMessages 每回合调一两次(非热循环),
   * 这点拷贝成本相对一次 API 往返可忽略。
   */
  getMessages(): Message[] {
    return structuredClone(this.messages)
  }

  /**
   * Deep-clone only the messages from `start` onward. Same per-element clone semantics as
   * getMessages(), but skips cloning the discarded prefix — so building a compacted view
   * (summary + kept tail) costs O(tail), not O(whole ledger). start ≤ 0 ≡ getMessages().
   */
  sliceMessages(start: number): Message[] {
    return structuredClone(this.messages.slice(start))
  }

  get length(): number {
    return this.messages.length
  }

  /** 把一个回合的用量累加进运行总计（故障模式⑧）。缺省 cache 字段按 0 计。 */
  addUsage(usage: Usage): void {
    this._totalUsage = {
      input_tokens: this._totalUsage.input_tokens + usage.input_tokens,
      output_tokens: this._totalUsage.output_tokens + usage.output_tokens,
      cache_read_input_tokens:
        (this._totalUsage.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens:
        (this._totalUsage.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    }
  }

  get totalUsage(): Usage {
    return { ...this._totalUsage }
  }

  clear(): void {
    this.messages = []
    this._totalUsage = emptyUsage()
  }

  toJSON(): ConversationSnapshot {
    return { version: 1, messages: this.getMessages(), totalUsage: this.totalUsage }
  }

  static fromJSON(data: ConversationSnapshot): Conversation {
    if (data.version !== 1) {
      throw new Error(`Unsupported conversation snapshot version: ${data.version}`)
    }
    const conv = new Conversation()
    data.messages.forEach((m, i) => {
      // legacy 会话无 id：按下标赋确定性 id（同一存档多次加载 id 不变）。带 id 的原样保留。
      conv.append(m.id ? m : { ...m, id: `msg_legacy_${i}` })
    })
    conv._totalUsage = { ...data.totalUsage }
    return conv
  }
}
