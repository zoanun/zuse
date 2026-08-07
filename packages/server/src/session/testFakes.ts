import type { ModelClient, Message, StreamEvent, ResolvedSettings } from '@zuse/core'
import type { SnapshotStore } from './events.js'
import type { PermissionPolicy } from './SessionManager.js'

/**
 * 交互式会话的 `settings` + `permissionPolicy` 一对入参，**与生产同构**。
 *
 * 关键点是 `config` 必须**就是** `settings.permissions` 那个对象 ——
 * createSession.ts 的交互式分支写的是 `config: settings.permissions`（没有 spread），
 * 两条判定路径共享同一份 permissions。此前测试各自传一个**另外的**字面量，
 * 于是「就地改 settings.permissions 会不会同步到 policy.config」这类断言
 * 跑在一个生产中根本不存在的拓扑上 —— 怎么写都不会红。
 *
 * 非交互（cron）会话**不能**用这个：那条路径生产上就是克隆的 config，
 * 与 settings.permissions 刻意分家（见 createSession.ts 的非交互分支）。
 */
export function interactiveOpts(settings: ResolvedSettings): { settings: ResolvedSettings; permissionPolicy: PermissionPolicy } {
  return { settings, permissionPolicy: { interactive: true, config: settings.permissions } }
}

/**
 * Scripted ModelClient for tests.
 * Each call to sendMessages pops the next script (array of StreamEvents) and
 * yields them in order, recording the messages it received.
 *
 * ModelClient.sendMessages real signature (from packages/core/src/model-client.ts):
 *   sendMessages(messages, config, tools?, signal?): AsyncIterable<StreamEvent>
 * The fake ignores config, tools, and signal — they are not needed for unit tests.
 */
export function fakeClient(
  scripts: StreamEvent[][],
  model = 'fake-model',
): { client: ModelClient; calls: Message[][] } {
  const calls: Message[][] = []
  let i = 0
  const client: ModelClient = {
    getModel: () => model,
    async *sendMessages(messages, _config, _tools, _signal) {
      calls.push(messages)
      const script = scripts[i++] ?? []
      for (const e of script) yield e
    },
  }
  return { client, calls }
}

/**
 * Minimal snapshot-store fake: track() returns incrementing hash strings;
 * restore() is a no-op. Used by SessionManager tests (Task 4+).
 */
export function fakeSnapshotStore(): SnapshotStore {
  let n = 0
  return { track: async () => `hash${++n}`, restore: async (_h: string) => {} }
}
