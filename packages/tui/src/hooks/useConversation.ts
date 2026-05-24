import { useState, useCallback } from 'react'
import type { UIMessage, ConversationState } from '../types.js'
import type { StreamEvent, Usage, ModelClient } from '@zuse/core'

interface UseConversationOptions {
  client: ModelClient
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
  const [state, setState] = useState<ConversationState>({
    messages: [],
    isThinking: false,
    lastUsage: undefined,
    error: undefined,
  })

  const sendMessage = useCallback(async (text: string) => {
    // Add user message
    const userMessage: UIMessage = {
      id: generateId(),
      role: 'user',
      text,
      isStreaming: false,
    }

    // Create placeholder for assistant response
    const assistantMessage: UIMessage = {
      id: generateId(),
      role: 'assistant',
      text: '',
      isStreaming: true,
    }

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage, assistantMessage],
      isThinking: true,
      error: undefined,
    }))

    // Build core Message format
    const coreMessages = state.messages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.isStreaming))
      .map((m) => ({
        role: m.role,
        content: [{ type: 'text' as const, text: m.text }],
      }))
    // Add the new user message
    coreMessages.push({ role: 'user' as const, content: [{ type: 'text' as const, text: userMessage.text }] })

    let accumulatedText = ''
    let finalUsage: Usage | undefined

    try {
      // Stream events from client
      for await (const event of client.sendMessages(coreMessages, {
        model: client.getModel(),
        max_tokens: maxTokens,
      })) {
        if (event.type === 'text-delta') {
          accumulatedText += event.text
          // Update assistant message in place
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessage.id
                ? { ...m, text: accumulatedText }
                : m
            ),
          }))
        } else if (event.type === 'message-stop') {
          finalUsage = event.usage
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessage.id
                ? { ...m, isStreaming: false, usage: finalUsage }
                : m
            ),
            isThinking: false,
            lastUsage: finalUsage,
          }))
        } else if (event.type === 'error') {
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessage.id
                ? { ...m, isStreaming: false, text: `Error: ${event.message}` }
                : m
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
            : m
        ),
        isThinking: false,
        error: message,
      }))
    }
  }, [client, maxTokens, state.messages])

  const clear = useCallback(() => {
    setState({
      messages: [],
      isThinking: false,
      lastUsage: undefined,
      error: undefined,
    })
  }, [])

  return { state, sendMessage, clear }
}