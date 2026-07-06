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
  }
}

describe('applyClientMessage', () => {
  it('dispatches send to submit', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'send', text: 'hi' }), err)
    expect(mgr.submit).toHaveBeenCalledWith('hi')
    expect(err).not.toHaveBeenCalled()
  })

  it('dispatches interrupt / steer / permission-reply / switch-model', () => {
    const mgr = fakeMgr()
    const err = vi.fn()
    applyClientMessage(mgr, JSON.stringify({ type: 'interrupt' }), err)
    applyClientMessage(mgr, JSON.stringify({ type: 'steer', text: 'go' }), err)
    applyClientMessage(mgr, JSON.stringify({ type: 'permission-reply', id: 'p1', verdict: 'allow' }), err)
    applyClientMessage(mgr, JSON.stringify({ type: 'switch-model', providerId: 'anthropic', model: 'x' }), err)
    expect(mgr.interrupt).toHaveBeenCalled()
    expect(mgr.steer).toHaveBeenCalledWith('go')
    expect(mgr.resolvePermission).toHaveBeenCalledWith('p1', 'allow')
    expect(mgr.switchModel).toHaveBeenCalledWith('anthropic', 'x')
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
