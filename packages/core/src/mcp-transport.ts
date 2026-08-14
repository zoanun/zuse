import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { killTree } from './kill-tree.js'
import { trackChild, untrackChild } from './child-reaper.js'

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
    // 登记进兜底册子：daemon 崩溃（未捕获异常 / 未处理 rejection）时 close() 根本不会被调，
    // MCP server 会变孤儿。回溯审计在本机数出过 10 个残留的 MCP node 进程。
    trackChild(this.proc.pid)

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
      // 在 'exit'（不是 'close'）注销：进程一退出 pid 就可能被系统回收给别人，
      // 留在册子里等于让退出时那一发 taskkill /T /F 去误杀无辜进程。
      untrackChild(this.proc?.pid)
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
      // **杀整棵树，不是 `proc.kill()`。** `npx <server>` 在 Windows 上的真实后代树是
      // `cmd.exe → npx → node`，`proc.kill()` 只打第一层，孙进程留下来当孤儿。
      // 今天没出事是因为 MCP server 恰好实现了 stdin EOF 自退 —— 那是**它**做对了，
      // 不是这段代码做对了；换一个不自退的 server 就会留孤儿。
      killTree(this.proc.pid)
      this.proc = null
    }
  }
}

// ── SseTransport ────────────────────────────────────────────────────

/** Default timeout for waiting for the SSE `endpoint` event (ms). */
const SSE_ENDPOINT_TIMEOUT = 10_000

/** Default timeout for POST requests (ms). */
const SSE_POST_TIMEOUT = 30_000

/** Maximum reconnection attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 5

/** Initial reconnection delay (ms). */
const INITIAL_RECONNECT_DELAY = 1_000

/** Maximum reconnection delay (ms). */
const MAX_RECONNECT_DELAY = 30_000

export class SseTransport implements McpTransport {
  private messageHandler: ((msg: JsonRpcResponse) => void) | null = null
  private errorHandler: ((err: Error) => void) | null = null
  private closeHandler: (() => void) | null = null

  private abortController: AbortController | null = null
  private postAbortController: AbortController | null = null
  private endpointUrl: string | null = null
  private reconnectAttempts = 0
  private reconnectDelay = INITIAL_RECONNECT_DELAY
  private closed = false

  constructor(
    private readonly url: string,
    private readonly headers?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    this.closed = false
    await this.connectSse()
  }

  send(message: JsonRpcMessage): void {
    if (!this.endpointUrl) {
      throw new Error('SSE endpoint not established')
    }

    const postController = new AbortController()
    this.postAbortController = postController

    const timeoutId = setTimeout(() => postController.abort(), SSE_POST_TIMEOUT)

    fetch(this.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(message),
      signal: postController.signal,
    })
      .then(async (response) => {
        clearTimeout(timeoutId)
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          const err = new Error(`SSE POST failed: HTTP ${response.status} ${body}`)
          // If the message had an id, the error handler will be invoked,
          // but we also need to reject the pending request specifically.
          // The McpClient's onError handler will handle this.
          if (this.errorHandler) this.errorHandler(err)
        }
      })
      .catch((err) => {
        clearTimeout(timeoutId)
        if (err instanceof Error && err.name === 'AbortError') {
          if (this.closed) return // Expected during close()
          if (this.errorHandler) this.errorHandler(new Error('SSE POST request timed out'))
        } else {
          if (this.errorHandler) this.errorHandler(err instanceof Error ? err : new Error(String(err)))
        }
      })
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
    this.closed = true
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.postAbortController) {
      this.postAbortController.abort()
      this.postAbortController = null
    }
    this.endpointUrl = null
  }

  // ── Internal SSE connection logic ─────────────────────────────────

  private async connectSse(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.abortController = new AbortController()

      const timeoutId = setTimeout(() => {
        this.abortController?.abort()
        reject(new Error('SSE endpoint event timeout'))
      }, SSE_ENDPOINT_TIMEOUT)

      let resolved = false

      this.readSseStream(
        (eventType, data) => {
          if (eventType === 'endpoint' && !resolved) {
            clearTimeout(timeoutId)
            resolved = true
            this.endpointUrl = this.resolveEndpointUrl(data)
            this.reconnectAttempts = 0
            this.reconnectDelay = INITIAL_RECONNECT_DELAY
            resolve()
          } else if (eventType === 'message') {
            try {
              const msg = JSON.parse(data) as JsonRpcResponse
              if (this.messageHandler) this.messageHandler(msg)
            } catch {
              /* ignore malformed JSON */
            }
          }
        },
        (err) => {
          clearTimeout(timeoutId)
          if (!resolved) {
            reject(err)
          } else {
            // Connection dropped mid-session — trigger reconnect
            this.handleDisconnect()
          }
        },
      )
    })
  }

  private readSseStream(
    onEvent: (eventType: string, data: string) => void,
    onStreamError: (err: Error) => void,
  ): void {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...this.headers,
    }

    fetch(this.url, {
      method: 'GET',
      headers,
      signal: this.abortController?.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`SSE connection failed: HTTP ${response.status}`)
        }

        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error('SSE response has no readable body')
        }

        const decoder = new TextDecoder()
        let buffer = ''
        let currentEventType = 'message'
        let currentData = ''

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            // Keep the last (potentially incomplete) line in the buffer
            buffer = lines.pop() ?? ''

            for (const line of lines) {
              if (line.startsWith('event:')) {
                currentEventType = line.slice(6).trim()
              } else if (line.startsWith('data:')) {
                currentData = line.slice(5).trim()
              } else if (line === '' && currentData) {
                // Empty line = end of event
                onEvent(currentEventType, currentData)
                currentEventType = 'message'
                currentData = ''
              }
            }
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            if (this.closed) return // Expected during close()
          }
          throw err
        }

        // Stream ended naturally
        if (!this.closed) {
          this.handleDisconnect()
        }
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError' && this.closed) {
          return // Expected during close()
        }
        onStreamError(err instanceof Error ? err : new Error(String(err)))
      })
  }

  private resolveEndpointUrl(endpoint: string): string {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      return endpoint
    }
    // Relative URL — resolve against base
    const base = new URL(this.url)
    return new URL(endpoint, base).toString()
  }

  private handleDisconnect(): void {
    this.endpointUrl = null

    // Emit close so McpClient can reject pending requests
    if (this.closeHandler) this.closeHandler()

    if (this.closed) return

    // Attempt reconnection
    this.attemptReconnect()
  }

  private attemptReconnect(): void {
    if (this.closed) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (this.errorHandler) {
        this.errorHandler(
          new Error(`SSE reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts`),
        )
      }
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY)

    setTimeout(() => {
      if (this.closed) return
      this.connectSse().catch((err) => {
        if (this.errorHandler) {
          this.errorHandler(err instanceof Error ? err : new Error(String(err)))
        }
        this.attemptReconnect()
      })
    }, delay)
  }
}
