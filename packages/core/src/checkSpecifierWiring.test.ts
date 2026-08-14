import { describe, it, expect } from 'vitest'
import { runAgent } from './agent.js'
import { Conversation } from './conversation.js'
import { ToolRegistry, type Tool } from './tool.js'
import type { ModelClient } from './model-client.js'
import type { ResolvedSettings, StreamEvent, Usage, PermissionVerdict } from './types.js'

/**
 * `ToolContext.checkSpecifier` 的接线测（D5）。
 *
 * 单独成文件而不是塞进 agent.test.ts：这一组测的是**闸门语义在中途复检上有没有走样**，
 * 而不是 runAgent 本身。走样的后果很具体 —— 漏掉 verdict 处理那几行，用户点
 * 「本会话允许」在这条路上就不生效，WebFetch 每跳都会重弹。
 */

const USAGE: Usage = { input_tokens: 1, output_tokens: 1 }

/** 一个在 run 里回头过闸的工具：把复检结果原样吐出来，好让测试看见。 */
function probeTool(target: string): Tool {
  return {
    name: 'probe',
    description: 'calls ctx.checkSpecifier mid-run',
    inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
    specifierFor: (input: unknown) => (input as { host?: string }).host ?? null,
    specifierKind: 'opaque',
    run: async (_input, ctx) => ({
      output: `verdict:${ctx.checkSpecifier === undefined ? 'NO-GATE' : await ctx.checkSpecifier(target)}`,
    }),
  }
}

function scriptedClient(): ModelClient {
  const scripts: StreamEvent[][] = [
    [
      { type: 'tool-use', id: 'a', name: 'probe', input: { host: 'entry.example' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ],
    [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
  ]
  let i = 0
  return {
    getModel: () => 'fake',
    async *sendMessages() {
      for (const e of scripts[i++] ?? []) yield e
    },
  }
}

function settingsWith(p: Partial<ResolvedSettings['permissions']>): ResolvedSettings {
  return {
    tools: {},
    providers: {},
    permissions: { defaultMode: 'default', allow: ['probe(entry.example)'], ask: [], deny: [], ...p },
  }
}

async function runProbe(opts: {
  settings: ResolvedSettings
  canUseTool?: (r: unknown) => Promise<PermissionVerdict>
  sessionAllow?: string[]
  onPersistAllow?: (rule: string) => void
  onAutoAllow?: (name: string, spec: string | null) => void
}): Promise<string> {
  const reg = new ToolRegistry()
  reg.register(probeTool('target.example'))
  const events: StreamEvent[] = []
  for await (const e of runAgent({
    conversation: new Conversation(),
    client: scriptedClient(),
    registry: reg,
    userText: 'go',
    config: { model: 'fake', max_tokens: 100 },
    cwd: '.',
    signal: new AbortController().signal,
    settings: opts.settings,
    ...(opts.canUseTool ? { canUseTool: opts.canUseTool as never } : {}),
    ...(opts.sessionAllow ? { sessionAllow: opts.sessionAllow } : {}),
    ...(opts.onPersistAllow ? { onPersistAllow: opts.onPersistAllow } : {}),
    ...(opts.onAutoAllow ? { onAutoAllow: opts.onAutoAllow } : {}),
  })) {
    events.push(e)
  }
  const tr = events.find((e) => e.type === 'tool-result') as { output: string } | undefined
  return tr?.output ?? '(no tool-result)'
}

describe('ToolContext.checkSpecifier 接线', () => {
  it('确实被注入（工具在 run 里拿得到）', async () => {
    const out = await runProbe({ settings: settingsWith({ allow: ['probe(entry.example)', 'probe(target.example)'] }) })
    expect(out).not.toContain('NO-GATE')
    expect(out).toBe('verdict:allow')
  })

  it('deny 规则 → deny', async () => {
    const out = await runProbe({ settings: settingsWith({ deny: ['probe(target.example)'] }) })
    expect(out).toBe('verdict:deny')
  })

  it('ask + allow_session → allow，且进 sessionAllow 的是【目标】限定符', async () => {
    const sessionAllow: string[] = []
    const out = await runProbe({
      settings: settingsWith({ ask: ['probe(target.example)'] }),
      canUseTool: async () => 'allow_session',
      sessionAllow,
    })
    expect(out).toBe('verdict:allow')
    // 写 probe(entry.example) 是那个「拿入口限定符去问」的空闸 bug 在接线层的投影。
    expect(sessionAllow).toEqual(['probe(target.example)'])
  })

  it('ask + canUseTool 返回 deny → deny', async () => {
    const out = await runProbe({
      settings: settingsWith({ ask: ['probe(target.example)'] }),
      canUseTool: async () => 'deny',
    })
    expect(out).toBe('verdict:deny')
  })

  it('ask + canUseTool 缺席 → deny（与首次过闸同样 fail closed）', async () => {
    const out = await runProbe({ settings: settingsWith({ ask: ['probe(target.example)'] }) })
    expect(out).toBe('verdict:deny')
  })

  it('ask + allow_persist → onPersistAllow 被调', async () => {
    const persisted: string[] = []
    const out = await runProbe({
      settings: settingsWith({ ask: ['probe(target.example)'] }),
      canUseTool: async () => 'allow_persist',
      onPersistAllow: (r) => persisted.push(r),
    })
    expect(out).toBe('verdict:allow')
    expect(persisted).toEqual(['probe(target.example)'])
  })

  it('bypass 档放行也计入 onAutoAllow（否则横幅的「已自动放行 N 次」漏掉中途复检）', async () => {
    const auto: Array<[string, string | null]> = []
    const out = await runProbe({
      settings: settingsWith({ defaultMode: 'bypass' }),
      onAutoAllow: (n, s) => auto.push([n, s]),
    })
    expect(out).toBe('verdict:allow')
    // 首次过闸 1 次（entry）+ 中途复检 1 次（target）
    expect(auto).toEqual([['probe', 'entry.example'], ['probe', 'target.example']])
  })

  it('传给 canUseTool 的 rule/specifier 说的是同一件事', async () => {
    let seen: { rule?: string; specifier?: string | null; toolName?: string } = {}
    await runProbe({
      settings: settingsWith({ ask: ['probe(target.example)'] }),
      canUseTool: async (r) => {
        seen = r as typeof seen
        return 'deny'
      },
    })
    expect(seen.toolName).toBe('probe')
    expect(seen.specifier).toBe('target.example')
    expect(seen.rule).toBe('probe(target.example)')
  })
})
