import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettings, appendAllowRule, resolveModelSelection, resolveImageModelSelection, getProviderConfig, setModelInSettings, setMcpServerInSettings, getWebSearchConfig, resolveFailoverMode, DEFAULT_ALLOW_RULES, DEFAULT_PROVIDER_ID } from './settings.js'
import type { ResolvedSettings } from './types.js'

let dir: string
const p = (name: string): string => join(dir, name)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-settings-'))
  delete process.env.ZUSE_API_KEY
  delete process.env.ZUSE_PROXY
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.ZUSE_API_KEY
  delete process.env.ZUSE_PROXY
})

describe('loadSettings', () => {
  it('returns defaults when no files exist', () => {
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.permissions.defaultMode).toBe('default')
    // 空配置带内置默认 allow 基线；默认 deny 刻意为空。
    expect(s.permissions.allow).toEqual([...DEFAULT_ALLOW_RULES])
    expect(s.permissions.deny).toEqual([])
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
    // 内置默认 allow 基线在前，用户三层规则在其后叠加；deny 无默认基线。
    expect(s.permissions.allow).toEqual([...DEFAULT_ALLOW_RULES, 'Read(./**)', 'Bash(git status)'])
    expect(s.permissions.deny).toEqual(['Read(./.env)'])
  })

  it('dedupes permission rules repeated across layers, preserving first-seen order', () => {
    writeFileSync(p('u.json'), JSON.stringify({
      permissions: { allow: ['Read(./**)', 'Grep', 'Glob'], ask: ['Bash(*)', 'Write(./**)'] },
    }))
    writeFileSync(p('l.json'), JSON.stringify({
      permissions: { allow: ['Read(./**)', 'Grep', 'Glob', 'Bash(ls)'], ask: ['Bash(*)', 'Write(./**)'] },
    }))
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    // Bash(ls) 已在内置默认 allow 中，用户层重复的会被 dedupe 掉（保留默认里的首现）。
    expect(s.permissions.allow).toEqual([...DEFAULT_ALLOW_RULES, 'Read(./**)', 'Grep', 'Glob'])
    expect(s.permissions.ask).toEqual(['Bash(*)', 'Write(./**)'])
  })

  it('ZUSE_API_KEY env overrides file apiKey', () => {
    writeFileSync(p('l.json'), JSON.stringify({ apiKey: 'file-key' }))
    process.env.ZUSE_API_KEY = 'env-key'
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.apiKey).toBe('env-key')
  })

  it('proxy: local 层覆盖 user 层；无配置时为 undefined', () => {
    writeFileSync(p('u.json'), JSON.stringify({ proxy: 'http://user:1111' }))
    writeFileSync(p('l.json'), JSON.stringify({ proxy: 'http://local:2222' }))
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.proxy).toBe('http://local:2222')
    const none = loadSettings({ userPath: p('x.json'), projectPath: p('y.json'), localPath: p('z.json') })
    expect(none.proxy).toBeUndefined()
  })

  it('ZUSE_PROXY env overrides file proxy', () => {
    writeFileSync(p('l.json'), JSON.stringify({ proxy: 'http://file:3333' }))
    process.env.ZUSE_PROXY = 'http://env:4444'
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.proxy).toBe('http://env:4444')
  })

  it('throws a file-identifying error on bad JSON', () => {
    writeFileSync(p('l.json'), '{ not json')
    expect(() => loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') }))
      .toThrow(/l\.json/)
  })
})

describe('providers registry merge', () => {
  it('defaults providers to empty object when absent', () => {
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.providers).toEqual({})
  })

  it('deep-merges a provider by id across layers (project骨架 + local补key)', () => {
    writeFileSync(p('pj.json'), JSON.stringify({
      providers: { qwen: { protocol: 'anthropic', baseURL: 'https://dash/anthropic', models: ['qwen3-max'] } },
    }))
    writeFileSync(p('l.json'), JSON.stringify({
      providers: { qwen: { apiKey: 'sk-local' } },
    }))
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(s.providers.qwen).toEqual({
      protocol: 'anthropic',
      baseURL: 'https://dash/anthropic',
      apiKey: 'sk-local',
      models: ['qwen3-max'],
    })
  })

  it('higher layer overrides scalar provider fields but keeps untouched ones', () => {
    writeFileSync(p('pj.json'), JSON.stringify({
      providers: { ds: { protocol: 'openai', baseURL: 'https://a/v1', apiKey: 'sk-1', models: ['x'] } },
    }))
    writeFileSync(p('l.json'), JSON.stringify({
      providers: { ds: { baseURL: 'https://b/v1' } },
    }))
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    const ds = s.providers.ds!
    expect(ds.baseURL).toBe('https://b/v1')
    expect(ds.apiKey).toBe('sk-1')
    expect(ds.protocol).toBe('openai')
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

// ——— 新增：resolveModelSelection / getProviderConfig ———

const base = (over: Partial<ResolvedSettings>): ResolvedSettings => ({
  tools: {},
  permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
  providers: {},
  ...over,
})

afterEach(() => {
  delete process.env.ZUSE_API_KEY
  delete process.env.ZUSE_API_KEY_QWEN
})

describe('resolveModelSelection', () => {
  it('parses "<providerId>/<model>"', () => {
    expect(resolveModelSelection(base({ model: 'qwen/qwen3-max' }))).toEqual({ providerId: 'qwen', model: 'qwen3-max' })
  })
  it('treats bare string as default provider', () => {
    expect(resolveModelSelection(base({ model: 'claude-x' }))).toEqual({ providerId: 'default', model: 'claude-x' })
  })
  it('only splits on the first slash', () => {
    expect(resolveModelSelection(base({ model: 'ollama/qwen2.5/coder' }))).toEqual({ providerId: 'ollama', model: 'qwen2.5/coder' })
  })
  it('falls back to default provider + default model when model unset', () => {
    const sel = resolveModelSelection(base({}))
    expect(sel.providerId).toBe('default')
    expect(sel.model).toBeTruthy()
  })
})

describe('resolveImageModelSelection', () => {
  it('parses "<providerId>/<model>"', () => {
    expect(resolveImageModelSelection(base({ imageModel: 'anthropic/claude-opus-4-8' }))).toEqual({
      providerId: 'anthropic',
      model: 'claude-opus-4-8',
    })
  })
  it('returns null when imageModel unset', () => {
    expect(resolveImageModelSelection(base({}))).toBeNull()
  })
  it('treats bare string as default provider', () => {
    expect(resolveImageModelSelection(base({ imageModel: 'bare-model' }))).toEqual({
      providerId: DEFAULT_PROVIDER_ID,
      model: 'bare-model',
    })
  })
  it('only splits on the first slash', () => {
    expect(resolveImageModelSelection(base({ imageModel: 'openai/gpt-4o/vision' }))).toEqual({
      providerId: 'openai',
      model: 'gpt-4o/vision',
    })
  })
})

describe('getProviderConfig', () => {
  it('synthesizes a default anthropic provider from flat fields when no registry', () => {
    const cfg = getProviderConfig(base({ model: 'claude-x', baseURL: 'https://h', apiKey: 'sk-flat' }), 'default')
    expect(cfg).toEqual({ id: 'default', protocol: 'anthropic', baseURL: 'https://h', apiKey: 'sk-flat', models: ['claude-x'] })
  })
  it('uses ZUSE_API_KEY (folded into settings.apiKey by loadSettings) for the synthesized default provider', () => {
    const s = base({ model: 'claude-x', apiKey: 'sk-from-env' }) // 模拟 mergeLayers 已把 ZUSE_API_KEY 落到 apiKey
    expect(getProviderConfig(s, 'default').apiKey).toBe('sk-from-env')
  })
  it('reads a named provider from the registry, defaulting protocol to anthropic', () => {
    const s = base({ providers: { qwen: { baseURL: 'https://d', apiKey: 'sk-q', models: ['m'] } } })
    expect(getProviderConfig(s, 'qwen')).toEqual({ id: 'qwen', protocol: 'anthropic', baseURL: 'https://d', apiKey: 'sk-q', models: ['m'] })
  })
  it('prefers ZUSE_API_KEY_<ID> env over literal apiKey', () => {
    process.env.ZUSE_API_KEY_QWEN = 'sk-env'
    const s = base({ providers: { qwen: { protocol: 'openai', apiKey: 'sk-lit', models: [] } } })
    expect(getProviderConfig(s, 'qwen').apiKey).toBe('sk-env')
  })
  it('accepts a placeholder key (Ollama) without throwing', () => {
    const s = base({ providers: { ollama: { protocol: 'openai', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama', models: [] } } })
    expect(getProviderConfig(s, 'ollama').apiKey).toBe('ollama')
  })
  it('throws a provider-named error when key is missing', () => {
    const s = base({ providers: { ds: { protocol: 'openai', models: [] } } })
    expect(() => getProviderConfig(s, 'ds')).toThrow(/ds/)
  })
  it('throws when provider id is not in the registry', () => {
    expect(() => getProviderConfig(base({}), 'nope')).toThrow(/nope/)
  })
})

describe('getWebSearchConfig', () => {
  it('returns null when no webSearch block', () => {
    expect(getWebSearchConfig(base({}))).toBeNull()
  })
  it('returns null when no backend has a usable key', () => {
    const s = base({ webSearch: { backend: 'tavily', backends: { tavily: {} } } })
    expect(getWebSearchConfig(s)).toBeNull()
  })
  it('keeps only backends with a key, defaults maxResults to 5 and fallback to []', () => {
    const s = base({ webSearch: { backend: 'tavily', backends: { tavily: { apiKey: 'tvly-x' }, brave: {} } } })
    const cfg = getWebSearchConfig(s)
    expect(cfg).toEqual({ backend: 'tavily', fallback: [], maxResults: 5, backends: { tavily: { apiKey: 'tvly-x' } } })
  })
  it('falls back to the first keyed backend when the named backend has no key', () => {
    const s = base({ webSearch: { backend: 'tavily', backends: { tavily: {}, brave: { apiKey: 'BSA-x' } } } })
    expect(getWebSearchConfig(s)!.backend).toBe('brave')
  })
  it('carries fallback and maxResults through', () => {
    const s = base({
      webSearch: { backend: 'tavily', fallback: ['brave'], maxResults: 8, backends: { tavily: { apiKey: 'k' }, brave: { apiKey: 'k2' } } },
    })
    const cfg = getWebSearchConfig(s)!
    expect(cfg.fallback).toEqual(['brave'])
    expect(cfg.maxResults).toBe(8)
  })
})

describe('setModelInSettings', () => {
  it('writes the model field, creating the file if absent', () => {
    setModelInSettings('qwen/qwen3-max', p('l.json'))
    const data = JSON.parse(readFileSync(p('l.json'), 'utf8'))
    expect(data.model).toBe('qwen/qwen3-max')
  })

  it('updates only the model field, preserving other content', () => {
    writeFileSync(p('l.json'), JSON.stringify({ model: 'old', maxTokens: 8192, providers: { x: { apiKey: 'k' } } }, null, 2))
    setModelInSettings('deepseek/deepseek-chat', p('l.json'))
    const data = JSON.parse(readFileSync(p('l.json'), 'utf8'))
    expect(data.model).toBe('deepseek/deepseek-chat')
    expect(data.maxTokens).toBe(8192)
    expect(data.providers.x.apiKey).toBe('k')
  })

  it('is idempotent (same model → no error, value unchanged)', () => {
    writeFileSync(p('l.json'), JSON.stringify({ model: 'a/b' }))
    setModelInSettings('a/b', p('l.json'))
    expect(JSON.parse(readFileSync(p('l.json'), 'utf8')).model).toBe('a/b')
  })
})

describe('setMcpServerInSettings', () => {
  it('adds a server under mcpServers, creating the file if absent', () => {
    setMcpServerInSettings('playwright', { command: 'npx', args: ['@playwright/mcp'] }, p('l.json'))
    const data = JSON.parse(readFileSync(p('l.json'), 'utf8'))
    expect(data.mcpServers.playwright).toEqual({ command: 'npx', args: ['@playwright/mcp'] })
  })

  it('preserves existing fields and comments (surgical JSONC edit)', () => {
    writeFileSync(p('l.jsonc'), '{\n  // my config\n  "model": "a/b",\n  "providers": { "x": { "apiKey": "k" } }\n}\n')
    setMcpServerInSettings('srv', { command: 'run' }, p('l.json')) // base .json → resolves to existing .jsonc
    const text = readFileSync(p('l.jsonc'), 'utf8')
    expect(text).toContain('// my config') // comment preserved
    expect(text).toContain('"model": "a/b"') // existing fields untouched
    expect(text).toContain('"apiKey": "k"')
    // loadSettings reads the .jsonc layer (tolerates comments) → new server present.
    const resolved = loadSettings({ userPath: p('zz-absent.json'), projectPath: p('zz-absent2.json'), localPath: p('l.json') })
    expect(resolved.mcpServers?.srv).toEqual({ command: 'run' })
  })

  it('removes a server when config is null', () => {
    setMcpServerInSettings('a', { command: 'x' }, p('l.json'))
    setMcpServerInSettings('b', { command: 'y' }, p('l.json'))
    setMcpServerInSettings('a', null, p('l.json'))
    const data = JSON.parse(readFileSync(p('l.json'), 'utf8'))
    expect(data.mcpServers.a).toBeUndefined()
    expect(data.mcpServers.b).toEqual({ command: 'y' })
  })
})

describe('resolveFailoverMode', () => {
  const base: ResolvedSettings = {
    tools: {},
    permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
    providers: {},
  }
  it('缺省回退 dialog', () => {
    expect(resolveFailoverMode(base)).toBe('dialog')
  })
  it('显式 auto 生效', () => {
    expect(resolveFailoverMode({ ...base, failoverMode: 'auto' })).toBe('auto')
  })
  it('显式 dialog 生效', () => {
    expect(resolveFailoverMode({ ...base, failoverMode: 'dialog' })).toBe('dialog')
  })

  it('mergeLayers 让高层 failoverMode 覆盖低层(经 loadSettings 端到端验证)', () => {
    writeFileSync(p('u.json'), JSON.stringify({ failoverMode: 'dialog' }))
    writeFileSync(p('l.json'), JSON.stringify({ failoverMode: 'auto' }))
    const s = loadSettings({ userPath: p('u.json'), projectPath: p('pj.json'), localPath: p('l.json') })
    expect(resolveFailoverMode(s)).toBe('auto')
  })
})
