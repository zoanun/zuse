import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry, type ResolvedSettings } from '@zuse/core'
import { useConversation } from './useConversation.js'

/**
 * useConversation 的第一条测试，只钉一件事：`/clear` 必须取消待触发的自唤醒。
 *
 * **可观测代理**：wakeupTimerRef 是 hook 内部状态，外部够不着。但唤醒到点会调
 * sendMessage，而本测试没有配置任何 provider，所以 sendMessage 的第一句
 * `if (!clientRef.current)` 会把 state.error 设成「客户端未初始化」——「唤醒是否触发过」
 * 因此等价于「state.error 是否被设上」。第二条用例是第一条的对照：不 clear 时那个 error
 * 必须出现，否则第一条可能只是因为唤醒压根没排上而空过。
 *
 * **隔离**：这个 hook 会读写 ~/.zuse（记忆库、影子快照、会话文件）。测试把相关的
 * 目录环境变量全部指到临时目录 —— 否则跑一次测试就动了用户的真实记忆库。
 */

function makeSettings(): ResolvedSettings {
  return {
    providers: {},
    tools: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  } as unknown as ResolvedSettings
}

beforeAll(() => {
  const d = mkdtempSync(join(tmpdir(), 'zuse-tui-clear-'))
  process.env.ZUSE_MEMORY_DB = join(d, 'memory.db')
  process.env.ZUSE_MEMORY_MD = join(d, 'MEMORY.md')
  process.env.ZUSE_SNAPSHOTS_DIR = join(d, 'snapshots')
  process.env.ZUSE_SESSIONS_DIR = join(d, 'sessions')
  process.env.ZUSE_TOOL_OUTPUT_DIR = join(d, 'tool-output')
})

afterEach(() => { vi.useRealTimers() })

type Api = ReturnType<typeof useConversation>

/**
 * sendMessage 在 client 未初始化时会 `setState({ ...prev, error: '客户端未初始化' })`，
 * 但 `error` **并未声明在 ConversationState 上**（所以 UI 其实渲染不出这条错误 —— 那是另一个
 * 问题，不在本测试范围）。这里要读的正是那个运行时字段，故显式 cast。
 */
function stateError(api: Api): string | undefined {
  return (api.state as unknown as { error?: string }).error
}

/** 把 hook 的返回值捞出来给测试用；渲染内容无关紧要。 */
function Harness({ registry, sink }: { registry: ToolRegistry; sink: (api: Api) => void }) {
  const api = useConversation({ maxTokens: 1024, registry, cwd: process.cwd(), settings: makeSettings() })
  sink(api)
  return createElement(Text, null, String(api.state.messages.length))
}

function mount() {
  const registry = new ToolRegistry()
  let api!: Api
  const r = render(createElement(Harness, { registry, sink: (a: Api) => { api = a } }))
  return { registry, getApi: () => api, unmount: r.unmount }
}

describe('useConversation.clear() —— 待触发的自唤醒', () => {
  it('/clear 之后旧对话安排的唤醒不再打进新对话', async () => {
    vi.useFakeTimers()
    const { registry, getApi, unmount } = mount()

    const wakeup = registry.get('ScheduleWakeup')
    expect(wakeup).toBeDefined()
    await wakeup!.run({ delaySeconds: 30, message: '看看 CI' }, {} as never)

    getApi().clear()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(stateError(getApi())).toBeUndefined()   // 唤醒没触发 → sendMessage 没被调用
    unmount()
  })

  it('不 clear 时唤醒照常触发（这条是上一条的对照，防它空过）', async () => {
    vi.useFakeTimers()
    const { registry, getApi, unmount } = mount()

    const wakeup = registry.get('ScheduleWakeup')
    await wakeup!.run({ delaySeconds: 30, message: '看看 CI' }, {} as never)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(stateError(getApi())).toBe('客户端未初始化')  // 唤醒确实驱动了一次 sendMessage
    unmount()
  })
})
