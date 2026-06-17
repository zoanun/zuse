import { describe, it, expect } from 'vitest'
import { McpManager } from './mcp-registry.js'
import { ToolRegistry } from './tool.js'
import { McpClient } from './mcp-client.js'

describe('McpManager', () => {
  it('registerTools creates Tool wrappers with mcp__ prefix', () => {
    const manager = new McpManager()
    const registry = new ToolRegistry()

    // Manually inject a fake client with tools (bypassing connect)
    const client = new McpClient()
    Object.defineProperty(client, '_tools', {
      value: [
        {
          name: 'query',
          description: 'run a database query',
          inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
        },
      ],
      writable: true,
    })
    manager['clients'].set('mydb', client)

    const count = manager.registerTools(registry)

    expect(count).toBe(1)
    const tool = registry.get('mcp__mydb__query')
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('mcp__mydb__query')
    expect(tool!.description).toContain('[MCP: mydb]')
    expect(tool!.description).toContain('run a database query')
  })

  it('serverNames returns connected server names', () => {
    const manager = new McpManager()
    const client = new McpClient()
    manager['clients'].set('foo', client)
    manager['clients'].set('bar', client)

    expect(manager.serverNames.sort()).toEqual(['bar', 'foo'])
  })

  it('does not re-register existing tools', () => {
    const manager = new McpManager()
    const registry = new ToolRegistry()

    const client = new McpClient()
    Object.defineProperty(client, '_tools', {
      value: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }],
      writable: true,
    })
    manager['clients'].set('svc', client)

    manager.registerTools(registry)
    const count2 = manager.registerTools(registry)
    expect(count2).toBe(0)
  })
})
