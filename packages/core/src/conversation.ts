import type { Message, Usage } from './types.js'

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
  private _totalUsage: Usage = { input_tokens: 0, output_tokens: 0 }

  append(message: Message): void {
    this.messages.push(message)
  }

  appendUserText(text: string): void {
    this.append({ role: 'user', content: [{ type: 'text', text }] })
  }

  appendAssistantText(text: string): void {
    this.append({ role: 'assistant', content: [{ type: 'text', text }] })
  }

  /** 返回一份防御性拷贝 —— 调用方不得修改我们内部的数组。 */
  getMessages(): Message[] {
    return this.messages.map((m) => ({ role: m.role, content: [...m.content] }))
  }

  get length(): number {
    return this.messages.length
  }

  /** 把一个回合的用量累加进运行总计（故障模式⑧）。 */
  addUsage(usage: Usage): void {
    this._totalUsage = {
      input_tokens: this._totalUsage.input_tokens + usage.input_tokens,
      output_tokens: this._totalUsage.output_tokens + usage.output_tokens,
    }
  }

  get totalUsage(): Usage {
    return { ...this._totalUsage }
  }

  clear(): void {
    this.messages = []
    this._totalUsage = { input_tokens: 0, output_tokens: 0 }
  }

  toJSON(): ConversationSnapshot {
    return { version: 1, messages: this.getMessages(), totalUsage: this.totalUsage }
  }

  static fromJSON(data: ConversationSnapshot): Conversation {
    if (data.version !== 1) {
      throw new Error(`Unsupported conversation snapshot version: ${data.version}`)
    }
    const conv = new Conversation()
    for (const m of data.messages) conv.append(m)
    conv._totalUsage = { ...data.totalUsage }
    return conv
  }
}
