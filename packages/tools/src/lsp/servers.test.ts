import { describe, it, expect } from 'vitest'
import { lookupLanguage, LANGUAGE_SERVERS } from './servers.js'

describe('lookupLanguage', () => {
  it('maps .ts and .tsx to typescript', () => {
    expect(lookupLanguage('/x/a.ts')?.id).toBe('typescript')
    expect(lookupLanguage('/x/a.tsx')?.id).toBe('typescript')
  })
  it('maps .py to python, .go to go, .rs to rust, .java to java, .vue to vue, .lua to lua, .sh to bash', () => {
    expect(lookupLanguage('a.py')?.id).toBe('python')
    expect(lookupLanguage('a.go')?.id).toBe('go')
    expect(lookupLanguage('a.rs')?.id).toBe('rust')
    expect(lookupLanguage('a.java')?.id).toBe('java')
    expect(lookupLanguage('a.vue')?.id).toBe('vue')
    expect(lookupLanguage('a.lua')?.id).toBe('lua')
    expect(lookupLanguage('a.sh')?.id).toBe('bash')
  })
  it('is case-insensitive on extension', () => {
    expect(lookupLanguage('A.TS')?.id).toBe('typescript')
  })
  it('returns null for unknown extension', () => {
    expect(lookupLanguage('a.docx')).toBeNull()
    expect(lookupLanguage('noext')).toBeNull()
  })
  it('every config has command, extensions, ready, installHint', () => {
    for (const c of LANGUAGE_SERVERS) {
      expect(c.command).toBeTruthy()
      expect(c.extensions.length).toBeGreaterThan(0)
      expect(['immediate', 'awaitProgress', 'awaitNotification']).toContain(c.ready)
      expect(c.installHint).toBeTruthy()
    }
  })
  it('java config carries readyNotification and dataDirArg', () => {
    const java = LANGUAGE_SERVERS.find((c) => c.id === 'java')!
    expect(java.ready).toBe('awaitNotification')
    expect(java.readyNotification).toBe('language/status')
    expect(java.dataDirArg?.('/tmp/x')).toEqual(['-data', '/tmp/x'])
  })
})
