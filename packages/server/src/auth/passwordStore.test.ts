import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PasswordStore } from './passwordStore.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-auth-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('PasswordStore', () => {
  it('reports no password initially and generates a persistent tokenSecret', () => {
    const s = new PasswordStore(dir)
    expect(s.hasPassword()).toBe(false)
    const sec1 = s.getTokenSecret()
    expect(sec1.length).toBeGreaterThan(0)
    expect(new PasswordStore(dir).getTokenSecret()).toBe(sec1)
  })
  it('persists a password hash and reads it back', () => {
    const s = new PasswordStore(dir)
    s.setPasswordHash('scrypt$16384$abc$def')
    expect(s.hasPassword()).toBe(true)
    expect(new PasswordStore(dir).getPasswordHash()).toBe('scrypt$16384$abc$def')
  })
})
