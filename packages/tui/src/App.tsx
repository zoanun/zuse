import { useCallback, useEffect, useMemo } from 'react'
import { Box, Text, Static, useApp } from 'ink'
import { useInput } from './input/useInput.js'
import { InputBox } from './components/InputBox.js'
import { MessageList } from './components/MessageList.js'
import { StreamRenderer, MSG_PAD_X } from './components/StreamRenderer.js'
import { UsageFooter } from './components/UsageFooter.js'
import { Banner } from './components/Banner.js'
import { detectEditor, EDITOR_LABEL } from './commands/terminalSetup.js'
import { listCommands } from './commands/registry.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { ModelSelect } from './components/ModelSelect.js'
import { useDoublePress } from './hooks/useDoublePress.js'
import { useConversation } from './hooks/useConversation.js'
import { getDefaultMaxTokens, getWebSearchConfig, loadSettings, resolveContextWindow, resolveModelSelection, DEFAULT_PROVIDER_ID, type Conversation, type ResolvedSettings } from '@zuse/core'
import { homedir } from 'node:os'
import { createDefaultRegistry, LspManager, primeShellSnapshot, cwdSlug, scanSkills } from '@zuse/tools'
import { McpManager } from '@zuse/core'
import type { SessionCheckpoint } from './commands/sessionStore.js'
import type { UIMessage } from './types.js'

interface AppProps {
  /** 工作目录，由入口（index.tsx）一次性定好传入，工具的相对路径据此解析。 */
  cwd: string
  /** --continue/--resume 预载的会话(入口解析 argv 并读盘后传入;Phase 10A)。 */
  initialSession?: { conversation: Conversation; id: string; createdAt: string; checkpoints?: SessionCheckpoint[] }
}

/** 顶部一次性横幅（仿 Claude Code）：随首批 <Static> 内容打进终端滚动区,只渲染一次。 */
type StaticRow = { kind: 'banner' } | { kind: 'msg'; msg: UIMessage }

export function App({ cwd, initialSession }: AppProps) {
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
  // 技能清单:启动扫一次(用户级 ~/.zuse/skills + 项目级 .zuse/skills 向上收集),
  // 不热加载(新技能重启生效,Phase 14)。/skills 命令与 Skill 工具共用这份。
  const skills = useMemo(() => scanSkills(homedir(), cwd), [cwd])

  const registry = useMemo(() => {
    // 构建会话级 LSP 进程池，随 registry 一起在 settings 变化时重建。
    const lsp = new LspManager()
    // Memory 记忆按会话起始 cwd 归属项目(Bash cd 漂移不影响归属,Phase 13)。
    return createDefaultRegistry({ webSearch: getWebSearchConfig(resolved), lsp, memoryProject: cwdSlug(cwd), skills })
  }, [resolved, cwd, skills])

  // MCP servers: 启动时连接 settings 里配置的 MCP servers,工具注册到 registry。
  useEffect(() => {
    const servers = resolved.mcpServers
    if (!servers || Object.keys(servers).length === 0) return
    const mgr = new McpManager()
    void mgr.connectAll(servers).then(({ connected, failed }) => {
      if (connected.length > 0) {
        const sel = resolveModelSelection(resolved)
        const ctxWindow = resolveContextWindow(resolved, sel.providerId, sel.model)
        mgr.registerTools(registry, ctxWindow)
      }
      for (const f of failed) {
        console.error(`MCP server "${f.name}" failed to connect: ${f.error}`)
      }
    })
    return () => { void mgr.disconnectAll() }
  }, [resolved.mcpServers, registry])

  const {
    state,
    submit,
    steer,
    pendingPermission,
    resolvePermission,
    permissionQueueLength,
    pendingPermissionId,
    currentModel,
    currentProviderId,
    clientError,
    modelSelectorOpen,
    confirmModelSelection,
    closeModelSelector,
    badModels,
    interrupt,
    todos,
  } = useConversation({
    maxTokens: getDefaultMaxTokens(resolved),
    registry,
    cwd,
    settings: resolved,
    initialSession,
    skills,
  })

  // 应用退出：Ink 的默认 Ctrl+C 退出已在入口关掉（exitOnCtrlC:false），改由这里双击退出。
  const { exit } = useApp()
  const { pending: exitPending, press: pressCtrlC } = useDoublePress(() => exit())

  // 对话框 / 选择器打开时，把 Esc 交给它们自己处理，避免双重响应。
  const dialogOpen = pendingPermission !== null || modelSelectorOpen

  useInput((input, key) => {
    // Ctrl+C 双击退出：单击只提示，窗口内再按一次才真正退出（全局有效，含对话框打开时）。
    if (key.ctrl && input === 'c') {
      pressCtrlC()
      return
    }
    if (dialogOpen) return
    // Esc：流式中则中断；非流式时无操作（历史滚动已交给终端原生 scrollback）。
    if (key.escape) {
      interrupt()
      return
    }
  })

  const handleSubmit = useCallback(
    (text: string, displayText?: string, pasteFiles?: Record<number, string>) => {
      void submit(text, displayText, pasteFiles)
    },
    [submit],
  )

  // footer 显示 provider/model。扁平默认配置（providerId 为 'default' sentinel）或尚未初始化
  // （'unknown'）时不加前缀，避免出现无意义的 "default/xxx"。
  const modelLabel =
    currentProviderId === DEFAULT_PROVIDER_ID || currentProviderId === 'unknown'
      ? currentModel
      : `${currentProviderId}/${currentModel}`

  // 检测 VSCode 系集成终端（VSCode/Cursor/Windsurf）。检测到才在横幅里给出 /terminal-setup 引导，
  // 普通终端 Ctrl+Enter 本就能换行、无需提示。env 整个会话不变，memo 一次即可。
  const terminalTip = useMemo<string | undefined>(() => {
    const editor = detectEditor(process.env)
    return editor
      ? `${EDITOR_LABEL[editor]} 集成终端需先跑 /terminal-setup 才能用 Ctrl+Enter 换行`
      : undefined
  }, [])

  // `/` 命令菜单的候选清单。命令表是静态的，memo 一次即可，避免每帧重建数组引用。
  const commands = useMemo(() => listCommands(), [])

  // settings 加载失败或 client 初始化失败，都在此统一展示错误页。
  if (initError || clientError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>错误：{initError ?? clientError}</Text>
        <Text dimColor>请检查 ~/.zuse/settings.json 或 .zuse/settings.local.json 配置。</Text>
      </Box>
    )
  }

  // 仿 Claude Code：已完成的消息（非流式）打进 <Static> —— Ink 把它们一次性写入终端
  // 滚动区且永不重绘，从根上规避「输出超过终端高度时的重绘错位」。实时帧只剩仍在流式的
  // 那条消息 + footer + 输入框，因此输入框可随内容自由增高而不再钉死终端高度。
  const committed = state.messages.filter((m) => !m.isStreaming)
  const live = state.messages.filter((m) => m.isStreaming)
  // 横幅要展示模型，而模型在挂载后的 effect 里才解析（初值 'unknown'）。<Static> 渲染一次即冻结，
  // 故必须等模型就绪后再把横幅放进首行，否则会永久定格成 unknown。模型几乎在首帧后立即就绪，
  // 此前用户也无从产出已提交消息，因此横幅仍稳居第一行。
  const bannerReady = currentProviderId !== 'unknown'
  const rows: StaticRow[] = [
    ...(bannerReady ? [{ kind: 'banner' } as StaticRow] : []),
    ...committed.map((m): StaticRow => ({ kind: 'msg', msg: m })),
  ]

  return (
    // width="100%" 让根框占满终端宽度（Ink 只给内部 rootNode 设了终端列宽，这里显式撑满，
    // 子级 InputBox 的 width="100%" 才有满宽的基准）。仅横向，无关此前 height 的重绘问题。
    <Box flexDirection="column" width="100%">
      {/* key=generation：clear/load 整体替换会话时自增，强制 <Static> remount 重置其
          append-only 高水位，否则换入的历史会被上一会话的水位从头截断。 */}
      <Static key={state.generation} items={rows}>
        {(row) =>
          row.kind === 'banner' ? (
            <Box key="banner" paddingTop={1}>
              <Banner model={modelLabel} proxy={resolved.proxy} cwd={cwd} tip={terminalTip} />
            </Box>
          ) : (
            <Box key={row.msg.id} paddingX={MSG_PAD_X}>
              <StreamRenderer message={row.msg} cwd={cwd} />
            </Box>
          )
        }
      </Static>

      {/* 实时帧：仍在流式的消息 + 输入框/对话框 + 页脚。 */}
      {live.length > 0 && <MessageList messages={live} cwd={cwd} />}

      {todos.length > 0 && todos.some((t: { status: string }) => t.status !== 'completed') && (
        <Box flexDirection="column" marginBottom={1} paddingX={MSG_PAD_X}>
          {todos.map((t: { content: string; status: string }, i: number) => {
            const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'
            const color = t.status === 'completed' ? 'green' : t.status === 'in_progress' ? 'cyan' : undefined
            return (
              <Text key={i} color={color} dimColor={t.status === 'completed'}>
                {icon} {t.content}
              </Text>
            )
          })}
        </Box>
      )}

      {exitPending && <Text color="yellow">再按一次 Ctrl+C 退出</Text>}

      {pendingPermission ? (
        // key=队头 id:队头 A 兑现、B 顶上时强制 remount,否则 React 原地更新会让
        // SelectList 内部的光标 state 从 A 泄漏到 B(对 A 选「拒绝」后 B 直接预选拒绝)。
        <PermissionDialog
          key={pendingPermissionId}
          req={pendingPermission}
          onDecision={(v) => resolvePermission(v, pendingPermissionId)}
          queueLength={permissionQueueLength}
        />
      ) : modelSelectorOpen ? (
        <ModelSelect
          settings={resolved}
          currentProviderId={currentProviderId}
          currentModel={currentModel}
          badKeys={badModels}
          onConfirm={confirmModelSelection}
          onCancel={closeModelSelector}
        />
      ) : (
        <InputBox
          onSubmit={handleSubmit}
          isDisabled={false}
          isSteerMode={state.isThinking}
          onSteer={steer}
          commands={commands}
        />
      )}

      {/* 页脚紧贴输入框下方、靠右显示（见 UsageFooter）。 */}
      <UsageFooter
        totalUsage={state.totalUsage}
        contextTokens={state.contextTokens}
        contextWindow={resolveContextWindow(resolved, currentProviderId, currentModel)}
        isThinking={state.isThinking}
      />
    </Box>
  )
}
