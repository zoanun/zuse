import { Box, Text } from 'ink'
import { InputBox } from './components/InputBox.js'
import { MessageList } from './components/MessageList.js'
import { UsageFooter } from './components/UsageFooter.js'
import { useConversation } from './hooks/useConversation.js'
import { createAnthropicClientFromEnv, getDefaultMaxTokens } from '@zuse/core'
import { createDefaultRegistry } from '@zuse/tools'

// 整个会话期间工具集是固定的 —— 在组件外构建一次。
const registry = createDefaultRegistry()

export function App() {
  // 创建 client（没有 API key 时会抛错 —— 由错误展示处理）
  let client: ReturnType<typeof createAnthropicClientFromEnv> | null = null
  let initError: string | undefined

  try {
    client = createAnthropicClientFromEnv()
  } catch (err) {
    initError = err instanceof Error ? err.message : 'Failed to initialize client'
  }

  const { state, submit } = useConversation({
    client,
    maxTokens: getDefaultMaxTokens(),
    registry,
  })

  // 如有初始化错误则展示
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
        {state.error && !state.isThinking && (
          <Box paddingX={1}>
            <Text color="red">Error: {state.error}</Text>
          </Box>
        )}
      </Box>

      <UsageFooter
        model={client?.getModel() || 'unknown'}
        totalUsage={state.totalUsage}
        contextTokens={state.contextTokens}
        isThinking={state.isThinking}
      />

      <InputBox
        onSubmit={submit}
        isDisabled={state.isThinking}
      />
    </Box>
  )
}