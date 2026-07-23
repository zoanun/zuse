import { describe, it, expect, vi } from 'vitest'
import { applyClientMessage, type SessionManagerLike } from './clientMessage.js'

function fakeMgr(): SessionManagerLike & {
  submit: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  resolvePermission: ReturnType<typeof vi.fn>
  switchModel: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
  revert: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
  compactNow: ReturnType<typeof vi.fn>
  isBusy: ReturnType<typeof vi.fn>
} {
  return {
    submit: vi.fn(async () => {}),
    interrupt: vi.fn(() => true),
    steer: vi.fn(),
    resolvePermission: vi.fn(),
    switchModel: vi.fn(),
    reset: vi.fn(),
    revert: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    compactNow: vi.fn(async () => {}),
    // Default to idle; the steer dispatch routes on this (idle → submit, thinking → steer).
    isBusy: vi.fn(() => false),
  }
}

describe('applyClientMessage', () => {
  it('dispatches send to submit', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'send', text: 'hi' }), err)
    expect(mgr.submit).toHaveBeenCalledWith('hi', undefined, undefined, undefined, { messageId: undefined })
    expect(err).not.toHaveBeenCalled()
  })

  it('forwards the client-supplied messageId from a send frame to submit', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'send', text: 'hi', messageId: 'msg_u1' }), err)
    expect(mgr.submit).toHaveBeenCalledWith('hi', undefined, undefined, undefined, { messageId: 'msg_u1' })
    expect(err).not.toHaveBeenCalled()
  })

  it('passes image refs from a send frame through to submit', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    const images = [{ id: 'a', name: 'x.png', mediaType: 'image/png' }]
    applyClientMessage(mgr, JSON.stringify({ type: 'send', text: 'hi', images }), err)
    expect(mgr.submit).toHaveBeenCalledWith('hi', images, undefined, undefined, { messageId: undefined })
    expect(err).not.toHaveBeenCalled()
  })

  it('send forwards files to submit (I5b)', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    const files = [{ id: 'f1', name: 'a.pdf', mediaType: 'application/pdf' }]
    applyClientMessage(mgr, JSON.stringify({ type: 'send', text: 'hi', files }), err)
    expect(mgr.submit).toHaveBeenCalledWith('hi', undefined, undefined, files, { messageId: undefined })
  })

  it('dispatches interrupt / steer / permission-reply / switch-model', () => {
    const mgr = fakeMgr()
    mgr.isBusy.mockReturnValue(true) // a turn is running → steer folds in
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'interrupt' }), err)
    applyClientMessage(mgr, JSON.stringify({ type: 'steer', text: 'go' }), err)
    applyClientMessage(mgr, JSON.stringify({ type: 'permission-reply', id: 'p1', verdict: 'allow' }), err)
    applyClientMessage(mgr, JSON.stringify({ type: 'switch-model', providerId: 'anthropic', model: 'x' }), err)
    expect(mgr.interrupt).toHaveBeenCalled()
    expect(mgr.steer).toHaveBeenCalledWith('go', undefined, undefined, undefined, { messageId: undefined })
    expect(mgr.resolvePermission).toHaveBeenCalledWith('p1', 'allow')
    expect(mgr.switchModel).toHaveBeenCalledWith('anthropic', 'x')
    expect(err).not.toHaveBeenCalled()
  })

  it('a steer received while the server is IDLE is delivered as a normal (echoed) send, not queued', () => {
    // The client only sends 'steer' when IT thinks a turn is running; if it raced past turn-end the
    // server is already idle. Queuing it would bleed into a later, unrelated turn — so route it to
    // submit (echoed so the client's queued-preview resolves) instead of mgr.steer.
    const mgr = fakeMgr() // getState defaults to isThinking:false (idle)
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'steer', text: 'go' }), err)
    expect(mgr.steer).not.toHaveBeenCalled()
    expect(mgr.submit).toHaveBeenCalledWith('go', undefined, undefined, undefined, { echo: true, messageId: undefined })
    expect(err).not.toHaveBeenCalled()
  })

  it('an IDLE steer carrying attachments forwards them to submit (not dropped)', () => {
    // Idle-race: the steer becomes a normal echoed send. Its images/pastedTexts MUST reach submit —
    // dropping them (submit(text, undefined, undefined, …)) silently loses the attachments (data loss).
    const mgr = fakeMgr()
    const err = vi.fn()
    const images = [{ id: 'i1', name: 'a.png', mediaType: 'image/png' }]
    const pastedTexts = [{ id: 'pa', text: '日志' }]
    applyClientMessage(mgr, JSON.stringify({ type: 'steer', text: '', images, pastedTexts }), err)
    expect(mgr.submit).toHaveBeenCalledWith('', images, pastedTexts, undefined, { echo: true, messageId: undefined })
    expect(err).not.toHaveBeenCalled()
  })

  it('dispatches compact to compactNow (no payload required)', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'compact' }), err)
    expect(mgr.compactNow).toHaveBeenCalledTimes(1)
    expect(err).not.toHaveBeenCalled()
  })

  it('dispatches reset-session to reset (no payload required)', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'reset-session' }), err)
    expect(mgr.reset).toHaveBeenCalledTimes(1)
    expect(err).not.toHaveBeenCalled()
  })

  it('dispatches revert to mgr.revert with the checkpointId', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'revert', checkpointId: 'cp-1' }), err)
    expect(mgr.revert).toHaveBeenCalledWith('cp-1')
    expect(err).not.toHaveBeenCalled()
  })

  it('errors on a revert frame without a string checkpointId', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'revert' }), err)
    expect(mgr.revert).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('checkpointId'))
  })

  it('dispatches retry to mgr.retry (no payload required)', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'retry' }), err)
    expect(mgr.retry).toHaveBeenCalledTimes(1)
    expect(err).not.toHaveBeenCalled()
  })

  it('reports a rejected retry (turn already in progress)', async () => {
    const mgr = fakeMgr()
    mgr.retry = vi.fn(async () => { throw new Error('A turn is already in progress') })
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'retry' }), err)
    await Promise.resolve(); await Promise.resolve()
    expect(err).toHaveBeenCalledWith('A turn is already in progress')
  })

  it('errors on invalid JSON', () => {
    const err = vi.fn()
    applyClientMessage(fakeMgr(), 'not json', err)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'))
  })

  it('errors on a non-object / missing type', () => {
    const err = vi.fn()
    applyClientMessage(fakeMgr(), JSON.stringify(42), err)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('expected an object'))
  })

  it('errors on unknown type', () => {
    const err = vi.fn()
    applyClientMessage(fakeMgr(), JSON.stringify({ type: 'frobnicate' }), err)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('unknown message type'))
  })

  it('reports a rejected submit (turn already in progress)', async () => {
    const mgr = fakeMgr()
    mgr.submit = vi.fn(async () => { throw new Error('A turn is already in progress') })
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'send', text: 'x' }), err)
    await Promise.resolve()
    await Promise.resolve()
    expect(err).toHaveBeenCalledWith('A turn is already in progress')
  })

  it('reports a synchronous switch-model failure (unconfigured provider) instead of throwing', () => {
    const mgr = fakeMgr()
    mgr.switchModel = vi.fn(() => { throw new Error('Provider "nope" is not configured') })
    const err = vi.fn()
    expect(() => applyClientMessage(mgr, JSON.stringify({ type: 'switch-model', providerId: 'nope', model: 'x' }), err)).not.toThrow()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('not configured'))
  })

  it('errors on an invalid permission-reply verdict', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'permission-reply', id: 'p1', verdict: 'maybe' }), err)
    expect(mgr.resolvePermission).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('invalid "verdict"'))
  })
})
