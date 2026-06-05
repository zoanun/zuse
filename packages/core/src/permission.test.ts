import { describe, it, expect } from 'vitest'
import { buildRule, parseRule, matchesRule, decide } from './permission.js'
import type { Tool } from './tool.js'
import type { ResolvedSettings, PermissionMode } from './types.js'

const cwd = '/repo'

function tool(name: string, readOnly: boolean): Tool {
  return {
    name, description: '', inputSchema: { type: 'object', properties: {} },
    run: async () => ({ output: '' }), readOnly,
  }
}
const Read = tool('Read', true)
const Write = tool('Write', false)
const Bash = tool('Bash', false)

function settings(over: Partial<ResolvedSettings['permissions']> & { mode?: PermissionMode } = {}): ResolvedSettings {
  return {
    tools: {},
    permissions: {
      defaultMode: over.mode ?? 'default',
      allow: over.allow ?? [], ask: over.ask ?? [], deny: over.deny ?? [],
    },
  }
}

describe('rule grammar', () => {
  it('builds rules from name + specifier', () => {
    expect(buildRule('Bash', 'git status')).toBe('Bash(git status)')
    expect(buildRule('Read', null)).toBe('Read')
  })
  it('parses bare and parenthesized rules', () => {
    expect(parseRule('Read')).toEqual({ tool: 'Read', specifier: null })
    expect(parseRule('Bash(git diff *)')).toEqual({ tool: 'Bash', specifier: 'git diff *' })
  })
})

describe('matchesRule', () => {
  it('bare rule matches any call of that tool', () => {
    expect(matchesRule('Read', 'Read', '/repo/a.ts', cwd)).toBe(true)
    expect(matchesRule('Read', 'Write', '/repo/a.ts', cwd)).toBe(false)
  })
  it('Bash prefix and exact matching', () => {
    expect(matchesRule('Bash(git diff *)', 'Bash', 'git diff HEAD', cwd)).toBe(true)
    expect(matchesRule('Bash(git status)', 'Bash', 'git status', cwd)).toBe(true)
    expect(matchesRule('Bash(git status)', 'Bash', 'git statusx', cwd)).toBe(false)
    expect(matchesRule('Bash(*)', 'Bash', 'rm -rf /', cwd)).toBe(true)
  })
  it('file path glob matching (relative to cwd)', () => {
    expect(matchesRule('Read(./src/**)', 'Read', '/repo/src/a/b.ts', cwd)).toBe(true)
    expect(matchesRule('Read(./.env)', 'Read', '/repo/.env', cwd)).toBe(true)
    expect(matchesRule('Read(./**/.env)', 'Read', '/repo/pkg/.env', cwd)).toBe(true)
    expect(matchesRule('Read(./src/**)', 'Read', '/repo/test/a.ts', cwd)).toBe(false)
  })
})

describe('decide', () => {
  it('deny beats allow', () => {
    const s = settings({ allow: ['Read(./**)'], deny: ['Read(./.env)'] })
    expect(decide(Read, '/repo/.env', s, [], cwd).decision).toBe('deny')
    expect(decide(Read, '/repo/a.ts', s, [], cwd).decision).toBe('allow')
  })
  it('bypassPermissions allows (but deny still wins)', () => {
    expect(decide(Bash, 'rm -rf /', settings({ mode: 'bypassPermissions' }), [], cwd).decision).toBe('allow')
    const s = settings({ mode: 'bypassPermissions', deny: ['Bash(rm -rf *)'] })
    expect(decide(Bash, 'rm -rf /', s, [], cwd).decision).toBe('deny')
  })
  it('ask rule yields ask', () => {
    expect(decide(Bash, 'npm i', settings({ ask: ['Bash(*)'] }), [], cwd).decision).toBe('ask')
  })
  it('default mode: readOnly allow, others ask', () => {
    expect(decide(Read, '/repo/a.ts', settings(), [], cwd).decision).toBe('allow')
    expect(decide(Write, '/repo/a.ts', settings(), [], cwd).decision).toBe('ask')
  })
  it('acceptEdits: Write allowed, Bash still ask', () => {
    expect(decide(Write, '/repo/a.ts', settings({ mode: 'acceptEdits' }), [], cwd).decision).toBe('allow')
    expect(decide(Bash, 'npm i', settings({ mode: 'acceptEdits' }), [], cwd).decision).toBe('ask')
  })
  it('session overlay suppresses ask', () => {
    const s = settings({ ask: ['Bash(*)'] })
    expect(decide(Bash, 'git status', s, ['Bash(git status)'], cwd).decision).toBe('allow')
  })
  it('disabled tool denies', () => {
    const s: ResolvedSettings = { tools: { disabled: ['Bash'] }, permissions: settings().permissions }
    expect(decide(Bash, 'ls', s, [], cwd).decision).toBe('deny')
  })
})
