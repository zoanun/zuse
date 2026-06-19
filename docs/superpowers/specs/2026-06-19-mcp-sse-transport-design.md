# MCP SSE Transport

> Date: 2026-06-19
> Status: Draft

## Problem

Zuse's MCP client (`packages/core/src/mcp-client.ts`) only supports stdio transport: it spawns a local child process and communicates via stdin/stdout JSON-RPC lines. The MCP protocol also defines an SSE (Server-Sent Events) transport for connecting to remote MCP servers over HTTP. This means Zuse cannot connect to remote MCP servers, cloud-hosted tool providers, or shared team servers that expose the SSE endpoint.

## Solution Overview

Introduce a transport abstraction layer that decouples the JSON-RPC request/response mechanism from the underlying communication channel. The existing stdio logic moves into a `StdioTransport` class, and a new `SseTransport` class handles HTTP-based communication. `McpClient` delegates all I/O to whichever transport is selected, keeping its public API (`connect()`, `callTool()`, `disconnect()`, `.tools`, `.name`) unchanged. Transport selection is automatic based on config shape.

## McpServerConfig Changes

The existing config type gains two optional fields. The presence of `command` vs `url` determines the transport:

```ts
export interface McpServerConfig {
  // --- stdio transport (existing) ---
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string

  // --- SSE transport (new) ---
  url?: string
  headers?: Record<string, string>
}
```

**Detection rule**: If `url` is present, use SSE transport. If `command` is present, use stdio transport. If both are present, `url` wins (SSE). If neither is present, throw a config validation error at connect time.

Settings file example:

```json
{
  "mcpServers": {
    "local-fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "remote-db": {
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer tok_abc123"
      }
    }
  }
}
```

## Transport Abstraction

### Interface

```ts
interface McpTransport {
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
```

`JsonRpcMessage` is the union of `JsonRpcRequest` and JSON-RPC notifications (no `id`).

### StdioTransport

Extracts the existing spawn + readline logic from `McpClient.connect()` into a class implementing `McpTransport`:

- `start()`: spawns the child process, sets up readline on stdout.
- `send()`: writes `JSON.stringify(msg) + '\n'` to stdin.
- `onMessage()`: readline `line` events, parsed as JSON.
- `onError()`: stderr data and spawn errors.
- `onClose()`: process `exit` event.
- `close()`: kills the child process, closes readline.

No behavioral change; this is a pure extraction refactor.

### SseTransport

Implements the MCP SSE protocol over HTTP:

- `start()`: Opens an SSE connection (via `EventSource` or manual `fetch` with streaming) to `{url}`. The server sends an `endpoint` event containing the POST URL for sending messages. The transport waits for this event before resolving.
- `send()`: POSTs JSON-RPC messages to the endpoint URL received during SSE setup. Content-Type: `application/json`. Includes configured `headers` on every request.
- `onMessage()`: SSE `message` events, parsed from `data:` lines as JSON.
- `onError()`: SSE connection errors and HTTP errors from POST requests.
- `onClose()`: SSE connection close.
- `close()`: Closes the SSE EventSource and aborts any in-flight POST requests.

## SSE Connection Lifecycle

```
Client                                  Server
  |                                       |
  |  GET /sse  (Accept: text/event-stream)|
  |-------------------------------------->|
  |                                       |
  |  event: endpoint                      |
  |  data: /messages?sessionId=abc123     |
  |<--------------------------------------|
  |                                       |
  |  POST /messages?sessionId=abc123      |
  |  { jsonrpc: "2.0", id: 1,            |
  |    method: "initialize", ... }        |
  |-------------------------------------->|
  |                                       |
  |  event: message                       |
  |  data: { jsonrpc: "2.0", id: 1,      |
  |    result: { serverInfo: ... } }      |
  |<--------------------------------------|
  |                                       |
  |  (tool calls follow same pattern)     |
  |                                       |
```

### Startup sequence

1. Open SSE stream to `config.url` with configured headers.
2. Wait for `endpoint` event. This gives the POST URL (may be relative or absolute).
3. Resolve the POST URL against the base URL if relative.
4. `start()` resolves. `McpClient` proceeds with the `initialize` handshake (same as stdio).

### Steady state

- Each `request()` or `notify()` call becomes a POST to the endpoint URL.
- Responses and server-initiated notifications arrive as SSE `message` events.
- The pending-request map (`id` -> `{resolve, reject}`) works identically to stdio.

## Reconnection

SSE connections can drop due to network issues. The transport implements automatic reconnection:

1. On SSE connection close or error, wait `reconnectDelay` (starting at 1s, exponential backoff up to 30s).
2. Re-open the SSE stream to `config.url`.
3. Wait for a new `endpoint` event (the session ID may change).
4. **Do not** replay the `initialize` handshake automatically. Instead, emit an `onClose` event so `McpClient` can decide whether to re-initialize.
5. If reconnection fails after `maxReconnectAttempts` (default: 5), emit `onError` with a terminal error and stop retrying.

**Rationale for not auto-re-initializing**: The MCP server may have lost session state. Letting `McpClient` handle re-initialization ensures the tool list is refreshed and any in-flight requests are properly rejected.

### Pending requests on disconnect

When the SSE stream drops, all pending requests are rejected with `Error('SSE connection lost')`. This matches the stdio behavior where pending requests are rejected on process exit.

## McpClient Changes

The refactored `McpClient` becomes transport-agnostic:

```ts
export class McpClient {
  private transport: McpTransport | null = null
  private pending = new Map<number, { resolve, reject }>()
  private serverName = ''
  private _tools: McpToolDef[] = []

  async connect(config: McpServerConfig): Promise<void> {
    // 1. Select transport
    this.transport = config.url
      ? new SseTransport(config.url, config.headers)
      : new StdioTransport(config.command!, config.args, config.env, config.cwd)

    // 2. Wire up message/error/close handlers
    this.transport.onMessage((msg) => { /* same pending-map logic */ })
    this.transport.onClose(() => { /* reject all pending */ })
    this.transport.onError((err) => { /* log or propagate */ })

    // 3. Start transport
    await this.transport.start()

    // 4. Initialize (same as before)
    const initResult = await this.request('initialize', { ... })
    this.serverName = initResult?.serverInfo?.name ?? 'unknown'
    await this.notify('notifications/initialized', {})
    const listResult = await this.request('tools/list', {})
    this._tools = listResult?.tools ?? []
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close()
      this.transport = null
    }
    for (const p of this.pending.values()) p.reject(new Error('disconnected'))
    this.pending.clear()
  }

  private request(method, params): Promise<unknown> {
    // Same pending-map pattern, but uses this.transport.send()
  }

  private notify(method, params): Promise<void> {
    // Same, but no id, no pending entry
  }
}
```

## Error Handling

| Scenario | Behavior |
|---|---|
| Invalid config (no `command` or `url`) | Throw `Error('McpServerConfig must have either "command" (stdio) or "url" (SSE)')` at connect time |
| SSE connection refused | `start()` rejects with connection error |
| SSE stream drops mid-session | Reject all pending requests; trigger reconnection logic |
| POST to endpoint returns HTTP 4xx/5xx | Reject the corresponding pending request with the HTTP status and body |
| POST to endpoint times out | Reject after 30s timeout (configurable) |
| `endpoint` event not received within timeout | `start()` rejects after 10s with `Error('SSE endpoint event timeout')` |
| Reconnection exhausted | Emit terminal error via `onError`; `McpManager` logs it |
| Malformed SSE data (not valid JSON) | Ignore the event (same as stdio ignoring non-JSON lines) |

## File Changes

| File | Change |
|---|---|
| `packages/core/src/mcp-transport.ts` | **New.** `McpTransport` interface, `StdioTransport` class, `SseTransport` class |
| `packages/core/src/mcp-client.ts` | Refactor to use `McpTransport`. Remove direct `spawn`/`readline` usage. Add config validation. `McpServerConfig` gains `url` and `headers` fields, `command` becomes optional. |
| `packages/core/src/mcp-registry.ts` | No changes. `McpManager` already delegates to `McpClient`; transport is invisible. |
| `packages/core/src/mcp-client.test.ts` | Add tests for config detection logic, SSE transport mocking, reconnection behavior |

## Non-Goals

- **Streamable HTTP transport** (the newer MCP transport that replaces SSE): out of scope for this iteration. The SSE transport covers the widely-deployed protocol version. Streamable HTTP can be added as a third transport later.
- **Client certificate / mTLS auth**: out of scope. The `headers` field covers Bearer tokens and API keys, which is sufficient for most remote MCP servers.
- **Bidirectional server-to-client requests** (e.g., `sampling/createMessage`): the current architecture does not support the server calling back into the client. This is a separate feature that requires changes beyond the transport layer.
