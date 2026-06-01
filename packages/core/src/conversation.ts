import type { Message, Usage } from './types.js'

/** Serialized form for /save and /load (Phase 2.7). version gates future migrations. */
export interface ConversationSnapshot {
  version: 1
  messages: Message[]
  totalUsage: Usage
}

/**
 * Conversation — the authoritative store of committed conversation history.
 * This is exactly what gets re-sent to the model each turn (stateless server).
 *
 * Pure data + operations, no React. The TUI holds an instance in a ref and
 * mirrors a render-friendly view into component state.
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

  /** A defensive copy — callers must not mutate our internal array. */
  getMessages(): Message[] {
    return this.messages.map((m) => ({ role: m.role, content: [...m.content] }))
  }

  get length(): number {
    return this.messages.length
  }

  /** Accumulate one turn's usage into the running total (fault mode ⑧). */
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
