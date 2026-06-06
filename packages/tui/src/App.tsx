import { useMemo } from 'react'
import { Box, Text } from 'ink'
import { InputBox } from './components/InputBox.js'
import { MessageList } from './components/MessageList.js'
import { UsageFooter } from './components/UsageFooter.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { useConversation } from './hooks/useConversation.js'
import { getDefaultMaxTokens, getWebSearchConfig, loadSettings, DEFAULT_PROVIDER_ID, type ResolvedSettings } from '@zuse/core'
import { createDefaultRegistry, LspManager } from '@zuse/tools'

interface AppProps {
  /** 工作目录，由入口（index.tsx）一次性定好传入，工具的相对路径据此解析。 */
  cwd: string
}

export function App({ cwd }: AppProps) {
  // 启动时加载三层 settings（无 client 构建；client 由 hook 内部持有）。
  // 用 useMemo 只在挂载时读一次盘：流式期间每个 token 都会触发 App 重渲染，
  // 不缓存的话会反复读盘并新建 settings 对象，导致 hook 的 settings prop 引用每轮都变。
  const { settings, initError } = useMemo<{ settings: ResolvedSettings | null; initError?: string }>(() => {
    try {
      return { settings: loadSettings(), initError: undefined }
    } catch (err) {
      return { settings: null, initError: err instanceof Error ? err.message : 'Failed to load settings' }
    }
  }, [])

  // settings 缺失时的兜底对象（providers 必填）。同样用 useMemo 稳定引用。
  const resolved = useMemo<ResolvedSettings>(
    () => settings ?? { tools: {}, permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] }, providers: {} },
    [settings],
  )

  // 工具集随 settings 构建：WebSearch 需要配置（key），故在拿到 settings 后再建 registry。
  // 用 useMemo 锁定引用，避免流式期间每个 token 重渲染都重建工具集。
  const registry = useMemo(() => {
    // 构建会话级 LSP 进程池，随 registry 一起在 settings 变化时重建。
    const lsp = new LspManager()
    return createDefaultRegistry({ webSearch: getWebSearchConfig(resolved), lsp })
  }, [resolved])

  const { state, submit, pendingPermission, resolvePermission, currentModel, currentProviderId, clientError } =
    useConversation({
      maxTokens: getDefaultMaxTokens(resolved),
      registry,
      cwd,
      settings: resolved,
    })

  // footer 显示 provider/model。扁平默认配置（providerId 为 'default' sentinel）或尚未初始化
  // （'unknown'）时不加前缀，避免出现无意义的 "default/xxx"。
  const modelLabel =
    currentProviderId === DEFAULT_PROVIDER_ID || currentProviderId === 'unknown'
      ? currentModel
      : `${currentProviderId}/${currentModel}`

  // settings 加载失败或 client 初始化失败，都在此统一展示错误页。
  if (initError || clientError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>Error: {initError ?? clientError}</Text>
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
      </Box>

      <UsageFooter
        model={modelLabel}
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
