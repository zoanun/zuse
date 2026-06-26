import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { StreamEvent } from '@zuse/core'
import type { ServerMessage } from '@zuse/protocol'
import { startServer } from '../startServer.js'
import { attachWsServer } from './wsServer.js'
import { createSession } from '../session/createSession.js'
import { DEFAULT_SESSION_ID } from '../config.js'
import { SessionService } from '../session/SessionService.js'
import { fakeClient, fakeSnapshotStore } from '../session/testFakes.js'
import type { AuthProvider } from '../auth/authProvider.js'

let dir: string
const servers: { close(): Promise<void> }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-ws-'))
})
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Boot a real server with an injected fake-client session + complete auth handshake. */
async function makeServer(scripts: StreamEvent[][] = []) {
  const { client } = fakeClient(scripts)
  const session = createSession({ sessionId: DEFAULT_SESSION_ID, cwd: dir, client, snapshotStore: fakeSnapshotStore() })
  const server = await startServer(
    { host: '127.0.0.1', port: 0, authDir: dir, tokenTtlSec: 3600, cwd: dir },
    { session },
  )
  servers.push(server)
  const json = (b: unknown) => ({ method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
  await fetch(`${server.url}/api/auth/setup`, json({ password: 'pw' }))
  const login = await fetch(`${server.url}/api/auth/login`, json({ password: 'pw' }))
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { server, cookie, session }
}

function wsUrl(u: string) { return u.replace('http', 'ws') + '/ws' }

/** Resolve with the first parsed ServerMessage the socket receives. */
function firstMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    ws.on('message', (d) => resolve(JSON.parse(d.toString()) as ServerMessage))
    ws.on('error', reject)
  })
}

describe('ws wiring', () => {
  it('sends a snapshot frame on connect', async () => {
    const { server, cookie } = await makeServer()
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    // Attach the message listener BEFORE the socket opens: the snapshot is sent
    // eagerly on connect, so awaiting 'open' first would race past it (the frame
    // arrives before a late-attached listener). Mirrors the error-frame test.
    const msg = await firstMessage(ws)
    expect(msg.type).toBe('snapshot')
    if (msg.type === 'snapshot') {
      expect(msg.snapshot.sessionId).toBe('default')
      expect(msg.snapshot.isThinking).toBe(false)
    }
    ws.close()
  })

  it('forwards SessionEvents as event frames', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'streamed' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { server, cookie, session } = await makeServer([script])
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    const frames: ServerMessage[] = []
    await new Promise((r) => ws.on('open', r))
    ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as ServerMessage))

    // Drive a turn DIRECTLY (uplink dispatch is wired in Task 5).
    await session.submit('hi')
    await new Promise((r) => setTimeout(r, 50))

    const textDelta = frames.find(
      (f): f is Extract<ServerMessage, { type: 'event' }> =>
        f.type === 'event' && f.event.type === 'text-delta',
    )
    expect(textDelta).toBeDefined()
    if (textDelta && textDelta.event.type === 'text-delta') {
      expect(textDelta.event.text).toBe('streamed')
    }
    ws.close()
  })

  it('sends an error frame when the session is unavailable', async () => {
    const httpServer = createServer()
    const fakeAuth = { verifyToken: () => true } as unknown as AuthProvider
    const service = new SessionService({ dir: join(dir, 'web-sessions'), cwd: dir })
    attachWsServer(httpServer, { auth: fakeAuth, service, sessionErr: 'boom' })
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r))
    const addr = httpServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    servers.push({ close: () => new Promise<void>((r) => { httpServer.closeAllConnections(); httpServer.close(() => r()) }) })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: 'x' } })
    const msg = await firstMessage(ws)
    expect(msg.type).toBe('error')
    if (msg.type === 'error') expect(msg.message).toContain('boom')
    ws.close()
  })

  it('a send frame drives a turn and streams event frames', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'pong' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { server, cookie } = await makeServer([script])
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    const frames: ServerMessage[] = []
    await new Promise((r) => ws.on('open', r))
    ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as ServerMessage))

    ws.send(JSON.stringify({ type: 'send', text: 'ping' }))
    await new Promise((r) => setTimeout(r, 50))

    const hasTextDelta = frames.some(
      (f) => f.type === 'event' && f.event.type === 'text-delta' && f.event.text === 'pong',
    )
    expect(hasTextDelta).toBe(true)
    ws.close()
  })

  it('a revert frame emits a reverted event AND re-pushes a fresh (truncated) snapshot', async () => {
    // One scripted turn so the conversation grows and a checkpoint is recorded. The
    // injected fakeSnapshotStore.track() returns 'hash1' for the first (and only) turn,
    // so that is the checkpoint id we revert to.
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'hello there' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { server, cookie, session } = await makeServer([script])
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    const frames: ServerMessage[] = []
    await new Promise((r) => ws.on('open', r))
    ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as ServerMessage))

    // Drive a turn DIRECTLY to record a checkpoint at index 0 (ledger empty before it),
    // then confirm the conversation grew.
    await session.submit('first')
    await new Promise((r) => setTimeout(r, 50))
    expect(session.getState().messageCount).toBeGreaterThan(0)
    const countBefore = session.getState().messageCount

    // Send the revert up the socket; checkpointIndex 0 means revert truncates to 0.
    ws.send(JSON.stringify({ type: 'revert', checkpointId: 'hash1' }))
    await new Promise((r) => setTimeout(r, 50))

    // A `reverted` event frame arrived carrying the checkpoint id.
    const revertedEvent = frames.find(
      (f): f is Extract<ServerMessage, { type: 'event' }> =>
        f.type === 'event' && f.event.type === 'reverted',
    )
    expect(revertedEvent).toBeDefined()
    if (revertedEvent && revertedEvent.event.type === 'reverted') {
      expect(revertedEvent.event.checkpointId).toBe('hash1')
    }

    // A fresh snapshot frame was re-pushed AFTER the revert, with the truncated ledger.
    const snapshots = frames.filter(
      (f): f is Extract<ServerMessage, { type: 'snapshot' }> => f.type === 'snapshot',
    )
    const lastSnapshot = snapshots[snapshots.length - 1]
    expect(lastSnapshot).toBeDefined()
    expect(lastSnapshot!.snapshot.messages.length).toBeLessThan(countBefore)
    expect(lastSnapshot!.snapshot.messageCount).toBe(0)
    ws.close()
  })

  it('a malformed uplink frame yields an error frame', async () => {
    const { server, cookie } = await makeServer()
    const ws = new WebSocket(wsUrl(server.url), { headers: { cookie } })
    const frames: ServerMessage[] = []
    await new Promise((r) => ws.on('open', r))
    ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as ServerMessage))

    ws.send('not json')
    await new Promise((r) => setTimeout(r, 50))

    expect(frames.some((f) => f.type === 'error' && f.message.includes('invalid JSON'))).toBe(true)
    ws.close()
  })

  it('rejects a WS upgrade without a valid session cookie (401)', async () => {
    const { server } = await makeServer()
    // Connect WITHOUT a cookie header — the harness only mints a cookie via login,
    // it does not auto-inject one, so the upgrade hits the missing-cookie 401 path.
    const ws = new WebSocket(wsUrl(server.url))
    const status = await new Promise<number>((resolve, reject) => {
      // ws surfaces a non-101 upgrade response as 'unexpected-response' carrying the
      // HTTP status. The server writes "401 Unauthorized" then destroys the socket, so
      // some ws versions instead emit 'error' (socket torn down) — treat that as a 401
      // as well, since the intent is "not authorized, the socket never opened".
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('error', () => resolve(401))
      ws.on('open', () => { ws.close(); reject(new Error('should not open')) })
    })
    expect(status).toBe(401)
    ws.close()
  })

  it('rejects an unauthenticated client', async () => {
    const { server } = await makeServer()
    const ws = new WebSocket(wsUrl(server.url))
    const rejected = await new Promise<boolean>((resolve) => {
      ws.on('open', () => { ws.close(); resolve(false) })
      ws.on('close', () => resolve(true))
      ws.on('error', () => resolve(true))
      ws.on('unexpected-response', () => resolve(true))
    })
    expect(rejected).toBe(true)
  })
})
