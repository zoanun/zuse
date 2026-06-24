import { describe, it, expect } from 'vitest'
import { parseCookies, serializeCookie } from './cookies.js'

describe('cookies', () => {
  it('parses a Cookie header', () => {
    expect(parseCookies('a=1; zuse_session=abc.def')).toEqual({ a: '1', zuse_session: 'abc.def' })
  })
  it('parses empty/undefined to {}', () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('')).toEqual({})
  })
  it('serializes an httpOnly cookie', () => {
    const c = serializeCookie('zuse_session', 'v', { httpOnly: true, sameSite: 'Lax', maxAgeSec: 60, secure: false })
    expect(c).toContain('zuse_session=v')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('Max-Age=60')
    expect(c).not.toContain('Secure')
  })
  it('adds Secure when requested', () => {
    expect(serializeCookie('k', 'v', { secure: true })).toContain('Secure')
  })
})
