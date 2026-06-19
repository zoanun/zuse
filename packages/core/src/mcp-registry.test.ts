import { describe, it, expect } from 'vitest'
import { ToolRegistry } from './tool.js'
import { McpManager } from './mcp-registry.js'
import { McpClient } from './mcp-client.js'

/** Helper: inject a fake client with tools into manager, bypassing connect. */
function injectClient(manager: McpManager, serverName: string, tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) {
  const client = new McpClient()
  Object.defineProperty(client, '_tools', { value: tools, writable: true })
  manager['clients'].set(serverName, client)
  return client
}

describe('McpManager.registerTools', () => {
  it('accepts optional contextWindowTokens parameter', () => {
    const mgr = new McpManager()
    const reg = new ToolRegistry()
    expect(mgr.registerTools(reg, 100000)).toBe(0)
    expect(mgr.registerTools(reg)).toBe(0)
  })

  it('registers tools directly when under threshold', () => {
    const mgr = new McpManager()
    const reg = new ToolRegistry()

    injectClient(mgr, 'svc', [
      { name: 'ping', description: 'ping the server', inputSchema: { type: 'object', properties: {} } },
    ])

    // Very large context window -> threshold is huge -> direct registration
    const count = mgr.registerTools(reg, 1_000_000)
    expect(count).toBe(1)
    expect(reg.get('mcp__svc__ping')).toBeDefined()
    expect(reg.get('McpSearch')).toBeUndefined()
  })

  it('registers McpSearch when descriptions exceed 10% of context window', () => {
    const mgr = new McpManager()
    const reg = new ToolRegistry()

    // Create a tool with a very long description
    const longDesc = 'x'.repeat(10000)
    injectClient(mgr, 'svc', [
      { name: 'big', description: longDesc, inputSchema: { type: 'object', properties: {} } },
    ])

    // Small context window: 10000 chars > 1000 * 0.1 * 4 = 400 chars threshold
    const count = mgr.registerTools(reg, 1000)
    expect(count).toBe(1) // Only McpSearch registered
    expect(reg.get('McpSearch')).toBeDefined()
    expect(reg.get('mcp__svc__big')).toBeUndefined()
  })

  it('registers directly when no contextWindowTokens given (Infinity threshold)', () => {
    const mgr = new McpManager()
    const reg = new ToolRegistry()

    const longDesc = 'x'.repeat(50000)
    injectClient(mgr, 'svc', [
      { name: 'big', description: longDesc, inputSchema: { type: 'object', properties: {} } },
    ])

    // No contextWindowTokens -> threshold is Infinity -> always direct
    const count = mgr.registerTools(reg)
    expect(count).toBe(1)
    expect(reg.get('mcp__svc__big')).toBeDefined()
    expect(reg.get('McpSearch')).toBeUndefined()
  })
})

describe('McpSearch tool', () => {
  function setupDeferred() {
    const mgr = new McpManager()
    const reg = new ToolRegistry()

    injectClient(mgr, 'db', [
      { name: 'query', description: 'Run a database query against postgres', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } },
      { name: 'migrate', description: 'Apply database migrations', inputSchema: { type: 'object', properties: {} } },
    ])
    injectClient(mgr, 'slack', [
      { name: 'send', description: 'Send a message to a Slack channel', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } } } },
    ])

    // Tiny context window forces deferred mode
    mgr.registerTools(reg, 1)

    const mcpSearch = reg.get('McpSearch')!
    expect(mcpSearch).toBeDefined()
    return { mgr, reg, mcpSearch }
  }

  it('search finds tools by keyword in name', async () => {
    const { mcpSearch } = setupDeferred()
    const result = await mcpSearch.run({ action: 'search', query: 'query' }, null as never)
    expect(result.output).toContain('mcp__db__query')
    expect(result.output).not.toContain('mcp__slack__send')
  })

  it('search finds tools by keyword in description', async () => {
    const { mcpSearch } = setupDeferred()
    const result = await mcpSearch.run({ action: 'search', query: 'slack' }, null as never)
    expect(result.output).toContain('mcp__slack__send')
  })

  it('search without query returns error with available tools', async () => {
    const { mcpSearch } = setupDeferred()
    const result = await mcpSearch.run({ action: 'search' }, null as never)
    expect(result.output).toContain("Missing 'query' for search.")
    expect(result.output).toContain('mcp__db__query')
  })

  it('search with no matches returns error with available tools', async () => {
    const { mcpSearch } = setupDeferred()
    const result = await mcpSearch.run({ action: 'search', query: 'nonexistent_xyz' }, null as never)
    expect(result.output).toContain("No MCP tools matched 'nonexistent_xyz'.")
    expect(result.output).toContain('mcp__db__query')
  })

  it('load registers a tool into the live registry', async () => {
    const { reg, mcpSearch } = setupDeferred()
    expect(reg.get('mcp__db__query')).toBeUndefined()

    const result = await mcpSearch.run({ action: 'load', tool: 'mcp__db__query' }, null as never)
    expect(result.output).toContain('mcp__db__query is now loaded and callable.')
    expect(reg.get('mcp__db__query')).toBeDefined()
    expect(reg.get('mcp__db__query')!.description).toContain('[MCP: db]')
  })

  it('load without tool name returns error', async () => {
    const { mcpSearch } = setupDeferred()
    const result = await mcpSearch.run({ action: 'load' }, null as never)
    expect(result.output).toContain("Missing 'tool' name to load.")
  })

  it('load unknown tool returns error', async () => {
    const { mcpSearch } = setupDeferred()
    const result = await mcpSearch.run({ action: 'load', tool: 'mcp__foo__bar' }, null as never)
    expect(result.output).toContain('Unknown MCP tool: mcp__foo__bar.')
  })

  it('load already-loaded tool returns already loaded message', async () => {
    const { reg, mcpSearch } = setupDeferred()

    // Load it first
    await mcpSearch.run({ action: 'load', tool: 'mcp__slack__send' }, null as never)
    expect(reg.get('mcp__slack__send')).toBeDefined()

    // Try again
    const result = await mcpSearch.run({ action: 'load', tool: 'mcp__slack__send' }, null as never)
    expect(result.output).toContain('Tool mcp__slack__send is already loaded and callable.')
  })

  it('missing action returns error', async () => {
    const { mcpSearch } = setupDeferred()
    const result = await mcpSearch.run({ action: 'invalid' }, null as never)
    expect(result.output).toBe("McpSearch requires action 'search' or 'load'.")
  })

  it('McpSearch is readOnly', () => {
    const { mcpSearch } = setupDeferred()
    expect(mcpSearch.readOnly).toBe(true)
  })
})

describe('McpManager.toolListing', () => {
  it('returns name + full description when under 80 chars', () => {
    expect(McpManager.toolListing('foo', 'short desc')).toBe('foo: short desc')
  })

  it('truncates description at 80 chars with ellipsis', () => {
    const long = 'a'.repeat(100)
    const result = McpManager.toolListing('bar', long)
    expect(result).toBe(`bar: ${'a'.repeat(80)}...`)
  })

  it('handles undefined description', () => {
    expect(McpManager.toolListing('baz', undefined)).toBe('baz: ')
  })
})
