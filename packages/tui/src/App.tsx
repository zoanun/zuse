import { Box, Text } from 'ink'
import { InputBox } from './components/InputBox.js'
import { MessageList } from './components/MessageList.js'
import { UsageFooter } from './components/UsageFooter.js'
import { useConversation } from './hooks/useConversation.js'
import { createAnthropicClientFromEnv, getDefaultMaxTokens } from '@zuse/core'

export function App() {
  // Create client (will throw if no API key — handled by error display)
  let client: ReturnType<typeof createAnthropicClientFromEnv> | null = null
  let initError: string | undefined

  try {
    client = createAnthropicClientFromEnv()
  } catch (err) {
    initError = err instanceof Error ? err.message : 'Failed to initialize client'
  }

  const { state, sendMessage } = useConversation({
    client: client!,
    maxTokens: getDefaultMaxTokens(),
  })

  // Show init error if any
  if (initError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>Error: {initError}</Text>
        <Text dimColor>Please check your .env configuration.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box padding={1}>
        <Text bold color="cyan">Zuse Chat</Text>
        <Text dimColor> (Ctrl+C to exit)</Text>
      </Box>

      <Box flexGrow={1} flexDirection="column">
        <MessageList messages={state.messages} />
        {state.isThinking && (
          <Box paddingX={1}>
            <Text dimColor color="yellow">Waiting for response...</Text>
          </Box>
        )}
        {state.error && !state.isThinking && (
          <Box paddingX={1}>
            <Text color="red">Error: {state.error}</Text>
          </Box>
        )}
      </Box>

      <UsageFooter
        model={client?.getModel() || 'unknown'}
        totalUsage={state.lastUsage}
        isThinking={state.isThinking}
      />

      <InputBox
        onSubmit={sendMessage}
        isDisabled={state.isThinking}
      />
    </Box>
  )
}