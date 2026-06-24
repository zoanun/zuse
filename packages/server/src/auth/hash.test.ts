import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './hash.js'

describe('password hashing', () => {
  it('hashes then verifies the same password', () => {
    const h = hashPassword('correct horse')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('correct horse', h)).toBe(true)
  })
  it('rejects a wrong password', () => {
    const h = hashPassword('correct horse')
    expect(verifyPassword('wrong', h)).toBe(false)
  })
  it('produces a different salt/hash each call for the same password', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'))
  })
  it('verify returns false on a malformed stored hash', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
  })
})
