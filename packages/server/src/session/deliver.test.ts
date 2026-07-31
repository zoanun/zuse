import { describe, it, expect, vi } from 'vitest'
import { deliverToSession } from './deliver.js'

function fake(busy: boolean) {
  return {
    isBusy: vi.fn(() => busy),
    steer: vi.fn(),
    submit: vi.fn(async () => {}),
  }
}

describe('deliverToSession', () => {
  it('回合进行中 → steer(折进当前回合)', () => {
    const mgr = fake(true)
    deliverToSession(mgr, 'hi', { messageId: 'm1' })
    expect(mgr.steer).toHaveBeenCalledWith('hi', undefined, undefined, undefined, { messageId: 'm1' })
    expect(mgr.submit).not.toHaveBeenCalled()
  })

  it('空闲 → submit,且 echo:true(否则前端的"排队中"预览化不成真气泡)', () => {
    const mgr = fake(false)
    deliverToSession(mgr, 'hi')
    expect(mgr.submit).toHaveBeenCalledWith('hi', undefined, undefined, undefined, { echo: true, messageId: undefined })
    expect(mgr.steer).not.toHaveBeenCalled()
  })

  it('submit 失败不抛出去,交给 onError', async () => {
    const mgr = fake(false)
    mgr.submit.mockRejectedValueOnce(new Error('boom'))
    const onError = vi.fn()
    deliverToSession(mgr, 'hi', { onError })
    await new Promise((r) => setImmediate(r))
    expect(onError).toHaveBeenCalledWith('boom')
  })
})
