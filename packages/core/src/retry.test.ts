import { describe, it, expect } from 'vitest'
import {
  isRetryableError,
  classifyError,
  retryAfterMs,
  backoffMs,
  resolveMaxRetries,
  sleep,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_CAP_MS,
} from './retry.js'

describe('isRetryableError', () => {
  it('retries on 408/409/429 and 5xx', () => {
    expect(isRetryableError({ status: 408 })).toBe(true)
    expect(isRetryableError({ status: 409 })).toBe(true)
    expect(isRetryableError({ status: 429 })).toBe(true)
    expect(isRetryableError({ status: 500 })).toBe(true)
    expect(isRetryableError({ status: 503 })).toBe(true)
    expect(isRetryableError({ status: 599 })).toBe(true)
    // statusCode 也认（部分 SDK/网络库用这个字段名）。
    expect(isRetryableError({ statusCode: 502 })).toBe(true)
  })

  it('does not retry on 4xx client errors', () => {
    expect(isRetryableError({ status: 400 })).toBe(false)
    expect(isRetryableError({ status: 401 })).toBe(false)
    expect(isRetryableError({ status: 403 })).toBe(false)
    expect(isRetryableError({ status: 404 })).toBe(false)
    expect(isRetryableError({ status: 422 })).toBe(false)
  })

  it('retries on transient network codes (incl. via cause)', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isRetryableError({ code: 'ECONNREFUSED' })).toBe(true)
    expect(isRetryableError({ code: 'EPIPE' })).toBe(true)
    expect(isRetryableError({ code: 'EAI_AGAIN' })).toBe(true)
    // code 藏在 cause 一层里也要挖到。
    expect(isRetryableError({ cause: { code: 'ECONNRESET' } })).toBe(true)
    expect(isRetryableError({ code: 'ENOTAFILE' })).toBe(false)
  })

  it('retries on SDK connection error class names', () => {
    expect(isRetryableError({ name: 'APIConnectionError' })).toBe(true)
    expect(isRetryableError({ name: 'APIConnectionTimeoutError' })).toBe(true)
  })

  it('never retries abort errors (user Esc / idle abort)', () => {
    expect(isRetryableError({ name: 'AbortError' })).toBe(false)
    expect(isRetryableError({ name: 'APIUserAbortError' })).toBe(false)
    // 即便带个可重试状态码，abort 优先级更高，仍不重试。
    expect(isRetryableError({ name: 'AbortError', status: 429 })).toBe(false)
  })

  it('non-object / unknown shapes are not retryable', () => {
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
    expect(isRetryableError('boom')).toBe(false)
    expect(isRetryableError(new Error('plain'))).toBe(false)
  })
})

describe('retryAfterMs', () => {
  it('parses retry-after from a plain headers object (seconds → ms)', () => {
    expect(retryAfterMs({ headers: { 'retry-after': '3' } })).toBe(3000)
    expect(retryAfterMs({ headers: { 'retry-after': 7 } })).toBe(7000)
  })

  it('parses retry-after from a Headers-like object with .get', () => {
    const headers = { get: (k: string): string | null => (k === 'retry-after' ? '5' : null) }
    expect(retryAfterMs({ headers })).toBe(5000)
  })

  it('returns null when absent, non-numeric, or non-positive', () => {
    expect(retryAfterMs({ headers: {} })).toBeNull()
    expect(retryAfterMs({ headers: { 'retry-after': 'soon' } })).toBeNull()
    expect(retryAfterMs({ headers: { 'retry-after': '0' } })).toBeNull()
    expect(retryAfterMs({})).toBeNull()
    expect(retryAfterMs(null)).toBeNull()
  })
})

describe('backoffMs', () => {
  // rng=()=>0.5 → 抖动系数 = 0.75 + 0.5*0.5 = 1.0，得确定值（= 指数项本身）。
  const det = (attempt: number, retryAfter?: number | null): number =>
    backoffMs(attempt, { retryAfter, baseMs: 500, capMs: DEFAULT_RETRY_CAP_MS, rng: () => 0.5 })

  it('grows exponentially from the base', () => {
    expect(det(0)).toBe(500) // 500 * 2^0
    expect(det(1)).toBe(1000) // 500 * 2^1
    expect(det(2)).toBe(2000)
    expect(det(3)).toBe(4000)
  })

  it('caps at capMs', () => {
    // 500*2^10 = 512000 远超 cap(32000)，应被钳到 cap（此处抖动系数为 1）。
    expect(det(10)).toBe(DEFAULT_RETRY_CAP_MS)
  })

  it('applies ±25% jitter from rng', () => {
    // rng=0 → 系数 0.75；rng→1 → 系数趋近 1.25。
    expect(backoffMs(0, { baseMs: 1000, rng: () => 0 })).toBe(750)
    expect(backoffMs(0, { baseMs: 1000, rng: () => 1 })).toBe(1250)
  })

  it('honors a positive retryAfter, overriding the computed backoff', () => {
    expect(det(5, 9000)).toBe(9000)
    // retryAfter 为 null/0 时忽略，走指数退避。
    expect(det(0, null)).toBe(500)
    expect(det(0, 0)).toBe(500)
  })
})

describe('resolveMaxRetries', () => {
  it('defaults when env is unset', () => {
    delete process.env.ZUSE_MAX_RETRIES
    expect(resolveMaxRetries()).toBe(DEFAULT_MAX_RETRIES)
  })

  it('reads a valid env value', () => {
    process.env.ZUSE_MAX_RETRIES = '3'
    try {
      expect(resolveMaxRetries()).toBe(3)
    } finally {
      delete process.env.ZUSE_MAX_RETRIES
    }
  })

  it('clamps negatives to 0 and falls back on invalid input', () => {
    process.env.ZUSE_MAX_RETRIES = '-2'
    expect(resolveMaxRetries()).toBe(0)
    process.env.ZUSE_MAX_RETRIES = 'nope'
    expect(resolveMaxRetries()).toBe(DEFAULT_MAX_RETRIES)
    delete process.env.ZUSE_MAX_RETRIES
  })
})

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const t0 = Date.now()
    await sleep(20)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
  })

  it('resolves early (does not block) when the signal aborts', async () => {
    const ac = new AbortController()
    const t0 = Date.now()
    const p = sleep(10_000, ac.signal)
    ac.abort()
    await p
    // 应几乎立即返回，远早于 10s。
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('resolves immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const t0 = Date.now()
    await sleep(10_000, ac.signal)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('classifyError', () => {
  it('401 → auth', () => {
    expect(classifyError({ status: 401 })).toEqual({ status: 401, category: 'auth' })
  })
  it('402 / 403 / 429 → quota', () => {
    for (const s of [402, 403, 429]) expect(classifyError({ status: s }).category).toBe('quota')
  })
  it('404 / 503 → unavailable', () => {
    for (const s of [404, 503]) expect(classifyError({ status: s }).category).toBe('unavailable')
  })
  it('400 / 422 / 无状态码 → other', () => {
    expect(classifyError({ status: 400 }).category).toBe('other')
    expect(classifyError({ status: 422 }).category).toBe('other')
    expect(classifyError(new Error('network')).category).toBe('other')
  })
  it('也识别 statusCode 字段', () => {
    expect(classifyError({ statusCode: 401 }).category).toBe('auth')
  })
})
