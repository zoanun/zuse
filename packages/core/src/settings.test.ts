import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettings, appendAllowRule } from './settings.js'

let dir: string
const p = (name: string): string => join(dir, name)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-settings-'))
  delete process.env.ZUSE_API_KEY
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.ZUSE_API_KEY
})

describe('loadSettings', () => {
  it('returns defaults when no files exist', () => {
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.permissions.defaultMode).toBe('default')
    expect(s.permissions.allow).toEqual([])
    expect(s.tools).toEqual({})
    expect(s.apiKey).toBeUndefined()
  })

  it('local overrides user for scalars; permission arrays concatenate', () => {
    writeFileSync(p('u.json'), JSON.stringify({
      model: 'user-model', apiKey: 'user-key',
      permissions: { allow: ['Read(./**)'], deny: ['Read(./.env)'] },
    }))
    writeFileSync(p('l.json'), JSON.stringify({
      model: 'local-model', apiKey: 'local-key',
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash(git status)'] },
    }))
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.model).toBe('local-model')
    expect(s.apiKey).toBe('local-key')
    expect(s.permissions.defaultMode).toBe('acceptEdits')
    expect(s.permissions.allow).toEqual(['Read(./**)', 'Bash(git status)'])
    expect(s.permissions.deny).toEqual(['Read(./.env)'])
  })

  it('ZUSE_API_KEY env overrides file apiKey', () => {
    writeFileSync(p('l.json'), JSON.stringify({ apiKey: 'file-key' }))
    process.env.ZUSE_API_KEY = 'env-key'
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.apiKey).toBe('env-key')
  })

  it('throws a file-identifying error on bad JSON', () => {
    writeFileSync(p('l.json'), '{ not json')
    expect(() => loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') }))
      .toThrow(/l\.json/)
  })
})

describe('appendAllowRule', () => {
  it('creates the local file (and dir) when absent', () => {
    const local = join(dir, 'nested', 'settings.local.json')
    appendAllowRule('Bash(git status)', local)
    expect(existsSync(local)).toBe(true)
    const data = JSON.parse(readFileSync(local, 'utf8'))
    expect(data.permissions.allow).toEqual(['Bash(git status)'])
  })

  it('appends to existing allow without dropping other fields', () => {
    const local = p('settings.local.json')
    writeFileSync(local, JSON.stringify({ apiKey: 'k', permissions: { allow: ['Read(./**)'] } }))
    appendAllowRule('Write(./a.ts)', local)
    const data = JSON.parse(readFileSync(local, 'utf8'))
    expect(data.apiKey).toBe('k')
    expect(data.permissions.allow).toEqual(['Read(./**)', 'Write(./a.ts)'])
  })

  it('is idempotent — skips a duplicate rule', () => {
    const local = p('settings.local.json')
    appendAllowRule('Bash(git status)', local)
    appendAllowRule('Bash(git status)', local)
    const data = JSON.parse(readFileSync(local, 'utf8'))
    expect(data.permissions.allow).toEqual(['Bash(git status)'])
  })
})
