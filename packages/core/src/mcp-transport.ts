import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

// ── JSON-RPC types ──────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ── Transport interface ─────────────────────────────────────────────

export interface McpTransport {
  /** Open the connection. Resolves when ready to send/receive. */
  start(): Promise<void>

  /** Send a JSON-RPC message (request or notification). */
  send(message: JsonRpcMessage): void

  /** Register a handler for incoming JSON-RPC messages. */
  onMessage(handler: (message: JsonRpcResponse) => void): void

  /** Register a handler for transport-level errors. */
  onError(handler: (error: Error) => void): void

  /** Register a handler for transport close/exit. */
  onClose(handler: () => void): void

  /** Shut down the transport and release resources. */
  close(): Promise<void>
}

// ── StdioTransport ──────────────────────────────────────────────────

export class StdioTransport implements McpTransport {
  private proc: ChildProcess | null = null
  private rl: Interface | null = null
  private messageHandler: ((msg: JsonRpcResponse) => void) | null = null
  private errorHandler: ((err: Error) => void) | null = null
  private closeHandler: (() => void) | null = null

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env?: Record<string, string>,
    private readonly cwd?: string,
  ) {}

  async start(): Promise<void> {
    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
      cwd: this.cwd,
      shell: true,
    })

    this.rl = createInterface({ input: this.proc.stdout! })

    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse
        if (this.messageHandler) this.messageHandler(msg)
      } catch {
        /* ignore non-JSON lines */
      }
    })

    this.proc.stderr?.on('data', (data: Buffer) => {
      if (this.errorHandler) {
        this.errorHandler(new Error(`MCP stderr: ${data.toString()}`))
      }
    })

    this.proc.on('error', (err) => {
      if (this.errorHandler) this.errorHandler(err)
    })

    this.proc.on('exit', () => {
      if (this.closeHandler) this.closeHandler()
    })
  }

  send(message: JsonRpcMessage): void {
    if (!this.proc?.stdin) {
      throw new Error('StdioTransport not started')
    }
    this.proc.stdin.write(JSON.stringify(message) + '\n')
  }

  onMessage(handler: (message: JsonRpcResponse) => void): void {
    this.messageHandler = handler
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  async close(): Promise<void> {
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}
