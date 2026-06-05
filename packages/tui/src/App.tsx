import { Box, Text } from 'ink'
import { InputBox } from './components/InputBox.js'
import { MessageList } from './components/MessageList.js'
import { UsageFooter } from './components/UsageFooter.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { useConversation } from './hooks/useConversation.js'
import { createAnthropicClient, getDefaultMaxTokens, loadSettings, type ResolvedSettings } from '@zuse/core'
import { createDefaultRegistry } from '@zuse/tools'

// 整个会话期间工具集是固定的 —— 在组件外构建一次。
const registry = createDefaultRegistry()

interface AppProps {
  /** 工作目录，由入口（index.tsx）一次性定好传入，工具的相对路径据此解析。 */
  cwd: string
}

export function App({ cwd }: AppProps) {
  // 启动时加载三层 settings 并据此创建 client（无 key 时抛错，走错误展示）。
  let client: ReturnType<typeof createAnthropicClient> | null = null
  let settings: ResolvedSettings | null = null
  let initError: string | undefined

  try {
    settings = loadSettings()
    client = createAnthropicClient(settings)
  } catch (err) {
    initError = err instanceof Error ? err.message : 'Failed to initialize client'
  }

  const { state, submit, pendingPermission, resolvePermission } = useConversation({
    client,
    maxTokens: settings ? getDefaultMaxTokens(settings) : 4096,
    registry,
    cwd,
    settings: settings ?? { tools: {}, permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
  })

  if (initError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>Error: {initError}</Text>
        <Text dimColor>请检查 ~/.zuse/settings.json 或 .zuse/settings.local.json 配置。</Text>
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

      {pendingPermission ? (
        <PermissionDialog req={pendingPermission} onDecision={resolvePermission} />
      ) : (
        <InputBox onSubmit={submit} isDisabled={state.isThinking} />
      )}
    </Box>
  )
}
