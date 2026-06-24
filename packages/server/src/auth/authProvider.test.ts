import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PasswordStore } from './passwordStore.js'
import { LocalPasswordAuth } from './authProvider.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-auth-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function auth() { return new LocalPasswordAuth(new PasswordStore(dir), 3600) }

describe('LocalPasswordAuth', () => {
  it('not configured initially; setup then configured', async () => {
    const a = auth()
    expect(await a.isConfigured()).toBe(false)
    await a.setup('pw')
    expect(await a.isConfigured()).toBe(true)
  })
  it('verifyCredential true for right, false for wrong', async () => {
    const a = auth(); await a.setup('pw')
    expect(await a.verifyCredential('pw')).toBe(true)
    expect(await a.verifyCredential('nope')).toBe(false)
  })
  it('issued token verifies; tampered does not', async () => {
    const a = auth(); await a.setup('pw')
    const t = a.issueToken()
    expect(a.verifyToken(t)).toBe(true)
    expect(a.verifyToken(t + 'x')).toBe(false)
  })
  it('setup twice throws (already configured)', async () => {
    const a = auth(); await a.setup('pw')
    await expect(a.setup('again')).rejects.toThrow()
  })
})
