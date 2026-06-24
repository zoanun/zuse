import { describe, it, expect } from 'vitest'
import { signToken, verifyToken } from './token.js'

const secret = 'test-secret-base64-or-any-string'

describe('session token', () => {
  it('signs then verifies', () => {
    const t = signToken(secret, 3600)
    expect(verifyToken(secret, t)).toBe(true)
  })
  it('rejects a token signed with a different secret', () => {
    const t = signToken(secret, 3600)
    expect(verifyToken('other-secret', t)).toBe(false)
  })
  it('rejects a tampered token', () => {
    const t = signToken(secret, 3600)
    expect(verifyToken(secret, t + 'x')).toBe(false)
  })
  it('rejects an expired token', () => {
    const t = signToken(secret, -1)
    expect(verifyToken(secret, t)).toBe(false)
  })
  it('rejects garbage', () => {
    expect(verifyToken(secret, 'garbage')).toBe(false)
  })
})
