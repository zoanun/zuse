import type { ModelClient, Message, StreamEvent } from '@zuse/core'
import type { SnapshotStore } from './events.js'

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
