import { describe, it, expect } from 'vitest'
import { StdioTransport } from './mcp-transport.js'

describe('StdioTransport', () => {
  it('throws on send before start', () => {
    const transport = new StdioTransport('echo', ['hello'])
    expect(() => transport.send({ jsonrpc: '2.0', id: 1, method: 'test' })).toThrow(
      'StdioTransport not started',
    )
  })

  it('close is safe when not started', async () => {
    const transport = new StdioTransport('echo', ['hello'])
    await expect(transport.close()).resolves.toBeUndefined()
  })
})
