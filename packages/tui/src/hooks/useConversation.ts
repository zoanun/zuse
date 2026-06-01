import { useState, useCallback, useRef } from 'react'
import type { UIMessage, ConversationState } from '../types.js'
import { Conversation, type ModelClient } from '@zuse/core'

interface UseConversationOptions {
  client: ModelClient | null
  maxTokens: number
}

interface UseConversationReturn {
  state: ConversationState
  sendMessage: (text: string) => Promise<void>
  clear: () => void
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function useConversation({ client, maxTokens }: UseConversationOptions): UseConversationReturn {
  // The committed history — the authoritative ledger that gets re-sent each turn.
  // Lives in a ref (not state): mutating it must not trigger a re-render, and we
  // never want a stale closure of it inside sendMessage.
  const conversationRef = useRef<Conversation>(new Conversation())

  // The render view. Mirrors the conversation, plus any in-flight (uncommitted)
  // user + assistant placeholder while streaming.
  const [state, setState] = useState<ConversationState>({
    messages: [],
    isThinking: false,
    totalUsage: undefined,
    contextTokens: undefined,
    error: undefined,
  })

  const sendMessage = useCallback(async (text: string) => {
    if (!client) {
      setState((prev) => ({ ...prev, error: 'Client not initialized' }))
      return
    }

    const conversation = conversationRef.current

    // Optimistic UI: show the user turn + an empty assistant placeholder at once.
    const userMessage: UIMessage = { id: generateId(), role: 'user', text, isStreaming: false }
    const assistantMessage: UIMessage = { id: generateId(), role: 'assistant', text: '', isStreaming: true }

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage, assistantMessage],
      isThinking: true,
      error: undefined,
    }))

    // Stateless server: send the committed history plus this new (still uncommitted)
    // user turn. Nothing is written to `conversation` until the turn succeeds, so a
    // failed turn leaves no dangling user message to break role alternation.
    const coreMessages = [
      ...conversation.getMessages(),
      { role: 'user' as const, content: [{ type: 'text' as const, text }] },
    ]

    let accumulatedText = ''

    try {
      for await (const event of client.sendMessages(coreMessages, {
        model: client.getModel(),
        max_tokens: maxTokens,
      })) {
        if (event.type === 'text-delta') {
          accumulatedText += event.text
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessage.id ? { ...m, text: accumulatedText } : m,
            ),
          }))
        } else if (event.type === 'message-stop') {
          // Commit the whole turn (user + assistant) to the ledger now that it succeeded.
          conversation.appendUserText(text)
          conversation.appendAssistantText(accumulatedText)
          conversation.addUsage(event.usage)
          const usage = event.usage
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessage.id ? { ...m, isStreaming: false, usage } : m,
            ),
            isThinking: false,
            totalUsage: conversation.totalUsage,
            contextTokens: usage.input_tokens,
          }))
        } else if (event.type === 'error') {
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessage.id
                ? { ...m, isStreaming: false, text: `Error: ${event.message}` }
                : m,
            ),
            isThinking: false,
            error: event.message,
          }))
          break
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setState((prev) => ({
        ...prev,
        messages: prev.messages.map((m) =>
          m.id === assistantMessage.id
            ? { ...m, isStreaming: false, text: `Error: ${message}` }
            : m,
        ),
        isThinking: false,
        error: message,
      }))
    }
  }, [client, maxTokens])

  const clear = useCallback(() => {
    conversationRef.current.clear()
    setState({
      messages: [],
      isThinking: false,
      totalUsage: undefined,
      contextTokens: undefined,
      error: undefined,
    })
  }, [])

  return { state, sendMessage, clear }
}
