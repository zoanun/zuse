import { describe, it, expect } from 'vitest'
import { ToolRegistry, type Tool } from './tool.js'

function fakeTool(name: string): Tool {
  return {
    name,
    description: `desc of ${name}`,
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ output: 'ok' }),
  }
}

describe('ToolRegistry', () => {
  it('registers and gets a tool by name', () => {
    const reg = new ToolRegistry()
    const tool = fakeTool('Read')
    reg.register(tool)
    expect(reg.get('Read')).toBe(tool)
  })

  it('returns undefined for an unknown tool', () => {
    const reg = new ToolRegistry()
    expect(reg.get('Nope')).toBeUndefined()
  })

  it('throws on duplicate registration', () => {
    const reg = new ToolRegistry()
    reg.register(fakeTool('Read'))
    expect(() => reg.register(fakeTool('Read'))).toThrow(/already registered/)
  })

  it('lists all registered tools', () => {
    const reg = new ToolRegistry()
    reg.register(fakeTool('Read'))
    reg.register(fakeTool('Write'))
    expect(reg.list().map((t) => t.name)).toEqual(['Read', 'Write'])
  })

  it('produces provider-facing definitions', () => {
    const reg = new ToolRegistry()
    reg.register(fakeTool('Read'))
    expect(reg.getDefinitions()).toEqual([
      {
        name: 'Read',
        description: 'desc of Read',
        input_schema: { type: 'object', properties: {} },
      },
    ])
  })
})
