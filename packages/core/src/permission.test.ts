import { describe, it, expect } from 'vitest'
import { buildRule, parseRule, matchesRule, decide, splitBashCommand } from './permission.js'
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
    providers: {},
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
    const s: ResolvedSettings = { tools: { disabled: ['Bash'] }, permissions: settings().permissions, providers: {} }
    expect(decide(Bash, 'ls', s, [], cwd).decision).toBe('deny')
  })
})

describe('splitBashCommand', () => {
  it('splits on top-level control operators', () => {
    expect(splitBashCommand('git status && rm -rf x')).toEqual(['git status', 'rm -rf x'])
    expect(splitBashCommand('a; b | c || d')).toEqual(['a', 'b', 'c', 'd'])
  })
  it('does not split inside quotes', () => {
    expect(splitBashCommand('echo "a | b" && ls')).toEqual(['echo "a | b"', 'ls'])
  })
  it('splits on a bare & (background) — it is a top-level separator too', () => {
    expect(splitBashCommand('sleep 10 & rm -rf /')).toEqual(['sleep 10', 'rm -rf /'])
    expect(splitBashCommand('npm run dev &')).toEqual(['npm run dev'])
  })
  it('does not split & inside redirections (2>&1 / >&2 / &>file)', () => {
    expect(splitBashCommand('cmd 2>&1')).toEqual(['cmd 2>&1'])
    expect(splitBashCommand('cmd >&2')).toEqual(['cmd >&2'])
    expect(splitBashCommand('cmd &>out.log')).toEqual(['cmd &>out.log'])
  })
})

describe('decide — Bash compound commands', () => {
  it('a prefix allow rule does NOT let a compound smuggle an extra command', () => {
    const s = settings({ allow: ['Bash(git status*)'] })
    expect(decide(Bash, 'git status', s, [], cwd).decision).toBe('allow')
    // 整条以 "git status" 开头,但第二段 rm 没有 allow 覆盖 → 不自动放行
    expect(decide(Bash, 'git status && rm -rf x', s, [], cwd).decision).toBe('ask')
  })
  it('a compound is allowed only when every sub-command is covered', () => {
    const s = settings({ allow: ['Bash(cd *)', 'Bash(npm test*)'] })
    expect(decide(Bash, 'cd src && npm test', s, [], cwd).decision).toBe('allow')
    expect(decide(Bash, 'cd src && npm publish', s, [], cwd).decision).toBe('ask')
  })
  it('deny matches any sub-command of a compound', () => {
    const s = settings({ allow: ['Bash(*)'], deny: ['Bash(rm -rf *)'] })
    expect(decide(Bash, 'ls && rm -rf /', s, [], cwd).decision).toBe('deny')
  })
  it('a bare & (background) cannot smuggle past deny or a prefix allow', () => {
    // 裸 & 也是分隔符：deny 必须命中后台串里的 rm,而非被整条前缀放行
    const denyS = settings({ allow: ['Bash(*)'], deny: ['Bash(rm -rf *)'] })
    expect(decide(Bash, 'sleep 10 & rm -rf /', denyS, [], cwd).decision).toBe('deny')
    // 前缀 allow 只覆盖第一段,后台串里的 rm 未覆盖 → 不自动放行
    const allowS = settings({ allow: ['Bash(git status*)'] })
    expect(decide(Bash, 'git status & rm -rf ~', allowS, [], cwd).decision).toBe('ask')
  })
  it('command substitution disables auto-allow decomposition', () => {
    const s = settings({ allow: ['Bash(echo*)'] })
    expect(decide(Bash, 'echo $(rm -rf x)', s, [], cwd).decision).toBe('ask')
  })
  it('a session-allowed exact compound command is re-allowed verbatim', () => {
    const s = settings({ ask: ['Bash(*)'] })
    expect(decide(Bash, 'cd src && npm test', s, ['Bash(cd src && npm test)'], cwd).decision).toBe('allow')
  })
})
