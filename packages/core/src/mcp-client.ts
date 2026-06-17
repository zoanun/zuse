import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

let nextId = 1

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class McpClient {
  private proc: ChildProcess | null = null
  private rl: Interface | null = null
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
    this.proc = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
      cwd: config.cwd,
      shell: true,
    })

    this.rl = createInterface({ input: this.proc.stdout! })
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            if (msg.error) p.reject(new Error(msg.error.message))
            else p.resolve(msg.result)
          }
        }
      } catch { /* ignore non-JSON lines */ }
    })

    this.proc.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('MCP server exited'))
      this.pending.clear()
    })

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
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    if (this.rl) {
      this.rl.close()
      this.rl = null
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
        this.proc!.stdin!.write(JSON.stringify(msg) + '\n')
      } catch (err) {
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private notify(method: string, params?: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const msg = { jsonrpc: '2.0', method, params }
        this.proc!.stdin!.write(JSON.stringify(msg) + '\n')
        resolve()
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }
}
