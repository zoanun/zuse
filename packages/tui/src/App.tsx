import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { InputBox } from './components/InputBox.js'
import { MessageList } from './components/MessageList.js'
import { UsageFooter } from './components/UsageFooter.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { ModelSelect } from './components/ModelSelect.js'
import { estimateMessageRows, computeHistoryWindow, clampOffsetRows } from './components/historyScroll.js'
import { useDoublePress } from './hooks/useDoublePress.js'
import { useConversation } from './hooks/useConversation.js'
import { getDefaultMaxTokens, getWebSearchConfig, loadSettings, DEFAULT_PROVIDER_ID, type ResolvedSettings } from '@zuse/core'
import { createDefaultRegistry, LspManager, primeShellSnapshot } from '@zuse/tools'

/**
 * 头部 + footer + 输入框等固定占用的终端行数估算。视口高度 = 终端行数 - 此值，
 * 用于历史滚动按行开窗，让渲染高度稳定贴住屏幕（顺带规避 Ink 输出超高时的重绘问题）。
 * 略给宽松：宁可视口小一点，也别让 UI 撑过终端高度。
 */
const CHROME_ROWS = 9

interface AppProps {
  /** 工作目录，由入口（index.tsx）一次性定好传入，工具的相对路径据此解析。 */
  cwd: string
}

export function App({ cwd }: AppProps) {
  // 启动即预热登录 shell 快照,把 ≤10s 的首次构建挪离首条 Bash 命令路径。
  // bash/zsh（Windows git-bash 或 POSIX 用户 $SHELL）下真正构建,其余降级无影响
  // （见 @zuse/tools 的 primeShellSnapshot）。
  useEffect(() => {
    void primeShellSnapshot()
  }, [])

  // 启动时加载三层 settings（无 client 构建；client 由 hook 内部持有）。
  // 用 useMemo 只在挂载时读一次盘：流式期间每个 token 都会触发 App 重渲染，
  // 不缓存的话会反复读盘并新建 settings 对象，导致 hook 的 settings prop 引用每轮都变。
  const { settings, initError } = useMemo<{ settings: ResolvedSettings | null; initError?: string }>(() => {
    try {
      return { settings: loadSettings(), initError: undefined }
    } catch (err) {
      return { settings: null, initError: err instanceof Error ? err.message : '加载配置失败' }
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

  // 历史滚动位置：从底部往上量的「行数」，0 = 贴底看最新。滚动是纯视图关注点，
  // 故 state 归 App 持有；/history 命令经注入回调 onScrollToTop 触发跳到最早处。
  const [offsetRows, setOffsetRows] = useState(0)
  // 每帧渲染时回写当前最大可滚行数，供按键处理器与 /history 在闭包外读取最新值夹取。
  const maxOffsetRef = useRef(0)
  const scrollToTop = useCallback(() => setOffsetRows(maxOffsetRef.current), [])

  const {
    state,
    submit,
    pendingPermission,
    resolvePermission,
    currentModel,
    currentProviderId,
    clientError,
    modelSelectorOpen,
    confirmModelSelection,
    closeModelSelector,
    interrupt,
  } = useConversation({
    maxTokens: getDefaultMaxTokens(resolved),
    registry,
    cwd,
    settings: resolved,
    onScrollToTop: scrollToTop,
  })

  // 终端尺寸：视口行数（开窗）与列宽（估算消息折行）都据此。非 TTY 给兜底值。
  const { stdout } = useStdout()
  const termRows = stdout?.rows ?? 24
  const termCols = stdout?.columns ?? 80
  const viewportRows = Math.max(4, termRows - CHROME_ROWS)
  const pageStep = Math.max(1, viewportRows - 1)

  // 估算每条消息的行数并开窗。messages/列宽变化时重算（流式逐 token 也会触发，但这是
  // O(条数) 的轻量计算）。窗口内部会把 offset 夹到 [0, maxOffsetRows]。
  const rowHeights = useMemo(
    () => state.messages.map((m) => estimateMessageRows(m, termCols)),
    [state.messages, termCols],
  )
  const win = computeHistoryWindow(rowHeights, viewportRows, offsetRows)
  maxOffsetRef.current = win.maxOffsetRows
  const visibleMessages = state.messages.slice(win.start, win.end)

  // 应用退出：Ink 的默认 Ctrl+C 退出已在入口关掉（exitOnCtrlC:false），改由这里双击退出。
  const { exit } = useApp()
  const { pending: exitPending, press: pressCtrlC } = useDoublePress(() => exit())

  // 对话框 / 选择器打开时，把滚动与 Esc 交给它们自己处理，避免双重响应。
  const dialogOpen = pendingPermission !== null || modelSelectorOpen

  useInput((input, key) => {
    // Ctrl+C 双击退出：单击只提示，窗口内再按一次才真正退出（全局有效，含对话框打开时）。
    if (key.ctrl && input === 'c') {
      pressCtrlC()
      return
    }
    if (dialogOpen) return
    // Esc：流式中则中断；否则把视口拉回底部（退出滚动浏览）。
    if (key.escape) {
      if (!interrupt()) setOffsetRows(0)
      return
    }
    // 翻页滚动：用 PageUp/PageDown——多行输入框的 keymap 不消费它们，故不与打字冲突
    //（↑/↓/←/→ 已被输入框用作光标移动，不能挪用）。
    if (key.pageUp) {
      setOffsetRows((o) => clampOffsetRows(o + pageStep, maxOffsetRef.current))
      return
    }
    if (key.pageDown) {
      setOffsetRows((o) => clampOffsetRows(o - pageStep, maxOffsetRef.current))
      return
    }
  })

  // 发送消息时回到底部：用户多半想看自己刚发的内容与即将到来的回复。
  const handleSubmit = useCallback(
    (text: string) => {
      setOffsetRows(0)
      void submit(text)
    },
    [submit],
  )

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
        <Text color="red" bold>错误：{initError ?? clientError}</Text>
        <Text dimColor>请检查 ~/.zuse/settings.json 或 .zuse/settings.local.json 配置。</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box padding={1}>
        <Text bold color="cyan">Zuse 对话</Text>
        <Text dimColor> (Ctrl+C 退出 · Esc 中断 · PageUp/PageDown 滚动)</Text>
      </Box>

      <Box flexGrow={1} flexDirection="column">
        {win.hiddenAbove > 0 && (
          <Text dimColor>  ↑ 还有 {win.hiddenAbove} 条更早（PageUp 上滚）</Text>
        )}
        <MessageList messages={visibleMessages} />
        {win.hiddenBelow > 0 && (
          <Text dimColor>  ↓ 还有 {win.hiddenBelow} 条更新（PageDown 下滚 · Esc 回到底部）</Text>
        )}
      </Box>

      <UsageFooter
        model={modelLabel}
        totalUsage={state.totalUsage}
        contextTokens={state.contextTokens}
        isThinking={state.isThinking}
      />

      {exitPending && <Text color="yellow">再按一次 Ctrl+C 退出</Text>}

      {pendingPermission ? (
        <PermissionDialog req={pendingPermission} onDecision={resolvePermission} />
      ) : modelSelectorOpen ? (
        <ModelSelect
          settings={resolved}
          currentProviderId={currentProviderId}
          currentModel={currentModel}
          onConfirm={confirmModelSelection}
          onCancel={closeModelSelector}
        />
      ) : (
        <InputBox onSubmit={handleSubmit} isDisabled={state.isThinking} />
      )}
    </Box>
  )
}
