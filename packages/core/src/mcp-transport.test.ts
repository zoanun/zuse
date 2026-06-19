import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StdioTransport, SseTransport } from './mcp-transport.js'
import type { JsonRpcResponse } from './mcp-transport.js'

// ── StdioTransport ──────────────────────────────────────────────────

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

// ── SseTransport ────────────────────────────────────────────────────

describe('SseTransport', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('throws on send before start', () => {
    const transport = new SseTransport('http://localhost:9999/sse')
    expect(() => transport.send({ jsonrpc: '2.0', id: 1, method: 'test' })).toThrow(
      'SSE endpoint not established',
    )
  })

  it('close is safe when not started', async () => {
    const transport = new SseTransport('http://localhost:9999/sse')
    await expect(transport.close()).resolves.toBeUndefined()
  })

  it('start() rejects on connection error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'))

    const transport = new SseTransport('http://localhost:9999/sse')
    await expect(transport.start()).rejects.toThrow('Connection refused')
  })

  it('start() rejects on non-OK HTTP response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    })

    const transport = new SseTransport('http://localhost:9999/sse')
    await expect(transport.start()).rejects.toThrow('SSE connection failed: HTTP 404')
  })

  it('start() rejects on endpoint event timeout', async () => {
    // Mock a stream that never sends an endpoint event
    const mockReader = {
      read: vi.fn().mockImplementation(
        () => new Promise(() => {}), // Never resolves
      ),
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    })

    const transport = new SseTransport('http://localhost:9999/sse')

    vi.useFakeTimers()
    const startPromise = transport.start()
    vi.advanceTimersByTime(10_001)
    await expect(startPromise).rejects.toThrow('SSE endpoint event timeout')
    vi.useRealTimers()
    await transport.close()
  })

  it('start() resolves after receiving endpoint event', async () => {
    const ssePayload =
      'event: endpoint\ndata: /messages?sessionId=abc123\n\n'

    const encoder = new TextEncoder()
    let readCount = 0
    const chunks = [encoder.encode(ssePayload)]

    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        if (readCount < chunks.length) {
          const chunk = chunks[readCount]!
          readCount++
          return Promise.resolve({ done: false, value: chunk })
        }
        // Keep stream open (never done) so we don't trigger disconnect
        return new Promise(() => {})
      }),
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    })

    const transport = new SseTransport('http://example.com/sse')
    await transport.start()
    // If start() resolved, the endpoint event was received
    await transport.close()
  })

  it('delivers SSE message events to onMessage handler', async () => {
    const endpointPayload = 'event: endpoint\ndata: /messages?sessionId=abc\n\n'
    const messagePayload =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'

    const encoder = new TextEncoder()
    let readCount = 0
    const chunks = [
      encoder.encode(endpointPayload),
      encoder.encode(messagePayload),
    ]

    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        if (readCount < chunks.length) {
          const chunk = chunks[readCount]!
          readCount++
          return Promise.resolve({ done: false, value: chunk })
        }
        return new Promise(() => {})
      }),
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    })

    const transport = new SseTransport('http://example.com/sse')

    const messages: JsonRpcResponse[] = []
    transport.onMessage((msg) => messages.push(msg))

    await transport.start()

    // Give the async stream reader a tick to process the message chunk
    await new Promise((r) => setTimeout(r, 50))

    expect(messages).toHaveLength(1)
    expect(messages[0]!.id).toBe(1)
    expect(messages[0]!.result).toEqual({ ok: true })

    await transport.close()
  })

  it('resolves relative endpoint URLs against the base SSE URL', async () => {
    const endpointPayload = 'event: endpoint\ndata: /messages?sessionId=abc\n\n'
    const encoder = new TextEncoder()
    let readCount = 0

    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        if (readCount === 0) {
          readCount++
          return Promise.resolve({ done: false, value: encoder.encode(endpointPayload) })
        }
        return new Promise(() => {})
      }),
    }

    const fetchCalls: Array<{ url: string; init: RequestInit }> = []

    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      if (init?.method === 'GET' || !init?.method) {
        return Promise.resolve({
          ok: true,
          body: { getReader: () => mockReader },
        })
      }
      // POST to endpoint
      return Promise.resolve({ ok: true, text: () => Promise.resolve('') })
    })

    const transport = new SseTransport('http://example.com/sse')
    transport.onError(() => {}) // swallow errors
    await transport.start()

    // Send a message — this should POST to the resolved URL
    transport.send({ jsonrpc: '2.0', id: 1, method: 'test' })

    // Wait for the POST to be made
    await new Promise((r) => setTimeout(r, 50))

    const postCall = fetchCalls.find((c) => c.init?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(postCall!.url).toBe('http://example.com/messages?sessionId=abc')

    await transport.close()
  })

  it('includes custom headers on both SSE GET and POST requests', async () => {
    const endpointPayload = 'event: endpoint\ndata: /messages?sessionId=abc\n\n'
    const encoder = new TextEncoder()
    let readCount = 0

    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        if (readCount === 0) {
          readCount++
          return Promise.resolve({ done: false, value: encoder.encode(endpointPayload) })
        }
        return new Promise(() => {})
      }),
    }

    const fetchCalls: Array<{ url: string; init: RequestInit }> = []

    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      if (init?.method === 'GET' || !init?.method) {
        return Promise.resolve({
          ok: true,
          body: { getReader: () => mockReader },
        })
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('') })
    })

    const transport = new SseTransport('http://example.com/sse', {
      Authorization: 'Bearer tok_abc',
    })
    transport.onError(() => {})
    await transport.start()

    transport.send({ jsonrpc: '2.0', id: 1, method: 'test' })
    await new Promise((r) => setTimeout(r, 50))

    // Check GET request includes custom headers
    const getCall = fetchCalls.find(
      (c) => !c.init?.method || c.init.method === 'GET',
    )
    expect(getCall).toBeDefined()
    expect((getCall!.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer tok_abc',
    )

    // Check POST request includes custom headers
    const postCall = fetchCalls.find((c) => c.init?.method === 'POST')
    expect(postCall).toBeDefined()
    expect((postCall!.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer tok_abc',
    )

    await transport.close()
  })

  it('calls onClose when SSE stream ends naturally', async () => {
    const endpointPayload = 'event: endpoint\ndata: /messages?sessionId=abc\n\n'
    const encoder = new TextEncoder()
    let readCount = 0

    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        if (readCount === 0) {
          readCount++
          return Promise.resolve({ done: false, value: encoder.encode(endpointPayload) })
        }
        // Stream ends
        return Promise.resolve({ done: true, value: undefined })
      }),
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    })

    const transport = new SseTransport('http://example.com/sse')

    let closeCalled = false
    transport.onClose(() => {
      closeCalled = true
    })
    transport.onError(() => {})

    await transport.start()

    // Wait for the stream reader to process the "done" signal
    await new Promise((r) => setTimeout(r, 50))

    expect(closeCalled).toBe(true)

    await transport.close()
  })

  it('handles absolute endpoint URLs', async () => {
    const endpointPayload =
      'event: endpoint\ndata: https://other.example.com/messages?sessionId=xyz\n\n'
    const encoder = new TextEncoder()
    let readCount = 0

    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        if (readCount === 0) {
          readCount++
          return Promise.resolve({ done: false, value: encoder.encode(endpointPayload) })
        }
        return new Promise(() => {})
      }),
    }

    const fetchCalls: Array<{ url: string; init: RequestInit }> = []

    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      fetchCalls.push({ url, init })
      if (init?.method === 'GET' || !init?.method) {
        return Promise.resolve({
          ok: true,
          body: { getReader: () => mockReader },
        })
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('') })
    })

    const transport = new SseTransport('http://example.com/sse')
    transport.onError(() => {})
    await transport.start()

    transport.send({ jsonrpc: '2.0', id: 1, method: 'test' })
    await new Promise((r) => setTimeout(r, 50))

    const postCall = fetchCalls.find((c) => c.init?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(postCall!.url).toBe('https://other.example.com/messages?sessionId=xyz')

    await transport.close()
  })

  it('ignores malformed JSON in SSE message events', async () => {
    const endpointPayload = 'event: endpoint\ndata: /messages?sessionId=abc\n\n'
    const badMessage = 'event: message\ndata: not-valid-json\n\n'

    const encoder = new TextEncoder()
    let readCount = 0
    const chunks = [
      encoder.encode(endpointPayload),
      encoder.encode(badMessage),
    ]

    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        if (readCount < chunks.length) {
          const chunk = chunks[readCount]!
          readCount++
          return Promise.resolve({ done: false, value: chunk })
        }
        return new Promise(() => {})
      }),
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    })

    const transport = new SseTransport('http://example.com/sse')
    const messages: JsonRpcResponse[] = []
    transport.onMessage((msg) => messages.push(msg))

    await transport.start()
    await new Promise((r) => setTimeout(r, 50))

    // Malformed JSON should be silently ignored
    expect(messages).toHaveLength(0)

    await transport.close()
  })
})
