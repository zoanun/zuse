import { StdioTransport, SseTransport } from './mcp-transport.js'
import type { McpTransport, JsonRpcRequest, JsonRpcResponse } from './mcp-transport.js'

let nextId = 1

export interface McpServerConfig {
  // --- stdio transport ---
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string

  // --- SSE transport ---
  url?: string
  headers?: Record<string, string>
}

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export class McpClient {
  private transport: McpTransport | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private serverName = ''
  private _tools: McpToolDef[] = []

  get tools(): readonly McpToolDef[] {
    return this._tools
  }

  get name(): string {
    return this.serverName
  }

  async connect(config: McpServerConfig): Promise<void> {
    // Select transport based on config shape: url → SSE, command → stdio
    if (config.url) {
      this.transport = new SseTransport(config.url, config.headers)
    } else if (config.command) {
      this.transport = new StdioTransport(config.command, config.args, config.env, config.cwd)
    } else {
      throw new Error('McpServerConfig must have either "command" (stdio) or "url" (SSE)')
    }

    // Wire up handlers
    this.transport.onMessage((msg: JsonRpcResponse) => {
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message))
          else p.resolve(msg.result)
        }
      }
    })

    this.transport.onClose(() => {
      for (const p of this.pending.values()) p.reject(new Error('MCP server exited'))
      this.pending.clear()
    })

    this.transport.onError((_err) => {
      // Transport-level errors are logged but not fatal by themselves.
      // Individual request failures are handled via the pending map.
    })

    // Start transport
    await this.transport.start()

    // Initialize handshake
    const initResult = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'zuse', version: '0.1.0' },
    }) as { serverInfo?: { name?: string } }

    this.serverName = initResult?.serverInfo?.name ?? 'unknown'

    await this.notify('notifications/initialized', {})

    const listResult = await this.request('tools/list', {}) as { tools?: McpToolDef[] }
    this._tools = listResult?.tools ?? []
  }

  async callTool(name: string, args: unknown): Promise<{ content: string; isError?: boolean }> {
    const result = await this.request('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }

    const text = (result?.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')

    return { content: text || '(no output)', isError: result?.isError }
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close()
      this.transport = null
    }
    for (const p of this.pending.values()) p.reject(new Error('disconnected'))
    this.pending.clear()
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++
      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
      this.pending.set(id, { resolve, reject })
      try {
        this.transport!.send(msg)
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private notify(method: string, params?: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const msg = { jsonrpc: '2.0' as const, method, params }
        this.transport!.send(msg)
        resolve()
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }
}
