import { McpClient, type McpServerConfig, type McpToolDef } from './mcp-client.js'
import { ToolRegistry } from './tool.js'
import type { Tool, JSONSchema } from './tool.js'

const MCP_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+a/i,
  /\bsystem\s*:/i,
  /<system>/i,
  /<human>/i,
  /<assistant>/i,
  /do\s+not\s+(tell|inform|reveal)/i,
  /forget\s+(all|everything|your)\s+(previous|prior)/i,
]

function scanMcpDescription(description: string, serverName: string, toolName: string): string {
  for (const pattern of MCP_INJECTION_PATTERNS) {
    if (pattern.test(description)) {
      return `[MCP: ${serverName}] Tool ${toolName} (description sanitized — contained suspicious patterns)`
    }
  }
  return `[MCP: ${serverName}] ${description}`
}

export interface McpServersConfig {
  [serverName: string]: McpServerConfig
}

/** A tool collected from a connected MCP server, bundled with its origin. */
interface CollectedTool {
  serverName: string
  client: McpClient
  toolDef: McpToolDef
  zuseToolName: string
}

export class McpManager {
  private clients = new Map<string, McpClient>()

  async connectAll(servers: McpServersConfig): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }> {
    const connected: string[] = []
    const failed: Array<{ name: string; error: string }> = []

    for (const [name, config] of Object.entries(servers)) {
      const client = new McpClient()
      try {
        await client.connect(config)
        this.clients.set(name, client)
        connected.push(name)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failed.push({ name, error: msg })
      }
    }

    return { connected, failed }
  }

  registerTools(registry: ToolRegistry, contextWindowTokens?: number): number {
    const allTools = this.collectAllTools(registry)
    if (allTools.length === 0) return 0

    const totalDescChars = allTools.reduce((sum, t) => sum + (t.toolDef.description?.length ?? 0), 0)
    const CHARS_PER_TOKEN = 4
    const thresholdChars = contextWindowTokens ? contextWindowTokens * 0.1 * CHARS_PER_TOKEN : Infinity

    if (totalDescChars > thresholdChars) return this.registerDeferred(registry, allTools)
    return this.registerDirect(registry, allTools)
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect()
    }
    this.clients.clear()
  }

  /** (Re)connect a single server: drop any existing same-name client, then connect fresh.
   *  Throws on connect failure (caller records it). Used for per-server reconnect (M4). */
  async connectServer(name: string, config: McpServerConfig): Promise<void> {
    await this.disconnectServer(name)
    const client = new McpClient()
    await client.connect(config)
    this.clients.set(name, client)
  }

  /** Disconnect + drop a single server if connected (no-op otherwise). */
  async disconnectServer(name: string): Promise<void> {
    const client = this.clients.get(name)
    if (!client) return
    await client.disconnect().catch(() => {})
    this.clients.delete(name)
  }

  get serverNames(): string[] {
    return [...this.clients.keys()]
  }

  /** Connected servers with their tools (name + description) — for the MCP management view (M4). */
  get servers(): Array<{ name: string; tools: Array<{ name: string; description?: string }> }> {
    return [...this.clients].map(([name, client]) => ({
      name,
      tools: client.tools.map((t) => ({ name: t.name, description: t.description })),
    }))
  }

  /** Short description for tool listings: name + first 80 chars of description. */
  static toolListing(name: string, description: string | undefined): string {
    const desc = description ?? ''
    const short = desc.length > 80 ? desc.slice(0, 80) + '...' : desc
    return `${name}: ${short}`
  }

  /** Gather all tools from all connected servers, skipping already-registered ones. */
  private collectAllTools(registry: ToolRegistry): CollectedTool[] {
    const collected: CollectedTool[] = []
    for (const [serverName, client] of this.clients) {
      for (const toolDef of client.tools) {
        const zuseToolName = `mcp__${serverName}__${toolDef.name}`
        if (registry.get(zuseToolName)) continue
        collected.push({ serverName, client, toolDef, zuseToolName })
      }
    }
    return collected
  }

  /** Create a Tool from a collected MCP tool entry. */
  private buildMcpTool(entry: CollectedTool): Tool {
    const { serverName, client, toolDef, zuseToolName } = entry
    return {
      name: zuseToolName,
      description: scanMcpDescription(toolDef.description ?? '', serverName, toolDef.name),
      inputSchema: toolDef.inputSchema as JSONSchema,
      async run(input: unknown) {
        try {
          const result = await client.callTool(toolDef.name, input)
          return { output: result.content, isError: result.isError }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { output: `MCP tool call failed: ${msg}. Do not retry immediately — try an alternative approach, or ask the user to check the MCP server.`, isError: true }
        }
      },
    }
  }

  /** Register all tools directly into the registry (original behavior). */
  private registerDirect(registry: ToolRegistry, allTools: CollectedTool[]): number {
    for (const entry of allTools) {
      registry.register(this.buildMcpTool(entry))
    }
    return allTools.length
  }

  /** Register a single McpSearch tool that can search and load individual MCP tools on demand. */
  private registerDeferred(registry: ToolRegistry, allTools: CollectedTool[]): number {
    const toolMap = new Map<string, CollectedTool>()
    for (const entry of allTools) {
      toolMap.set(entry.zuseToolName, entry)
    }

    const allNames = [...toolMap.keys()]
    const listing = allTools
      .map((e) => McpManager.toolListing(e.zuseToolName, e.toolDef.description))
      .join('\n')

    const mcpSearch: Tool = {
      name: 'McpSearch',
      readOnly: true,
      description:
        `Search and load deferred MCP tools. ${allTools.length} tools available but not yet loaded to save context.\n` +
        `Use action "search" with a query to find tools, or "load" with a tool name to make it callable.\n\n` +
        `Available tools:\n${listing}`,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'load'], description: 'Action to perform.' },
          query: { type: 'string', description: 'Keyword to search for (action=search).' },
          tool: { type: 'string', description: 'Exact tool name to load (action=load).' },
        },
        required: ['action'],
      },
      run: async (input: unknown) => {
        const { action, query, tool: toolName } = input as { action?: string; query?: string; tool?: string }
        const names = allNames.join(', ')

        if (action === 'search') {
          if (!query) {
            return { output: `Missing 'query' for search. Available tools: ${names}` }
          }
          const q = query.toLowerCase()
          const matches = allTools.filter(
            (e) =>
              e.zuseToolName.toLowerCase().includes(q) ||
              (e.toolDef.description ?? '').toLowerCase().includes(q),
          )
          if (matches.length === 0) {
            return { output: `No MCP tools matched '${query}'. Available: ${names}` }
          }
          const result = matches
            .map((e) => McpManager.toolListing(e.zuseToolName, e.toolDef.description))
            .join('\n')
          return { output: result }
        }

        if (action === 'load') {
          if (!toolName) {
            return { output: `Missing 'tool' name to load. Available: ${names}` }
          }
          const entry = toolMap.get(toolName)
          if (!entry) {
            return { output: `Unknown MCP tool: ${toolName}. Available: ${names}` }
          }
          // Check if already loaded (e.g. from a previous load call)
          if (registry.get(toolName)) {
            return { output: `Tool ${toolName} is already loaded and callable.` }
          }
          registry.register(this.buildMcpTool(entry))
          return { output: `Tool ${toolName} is now loaded and callable.` }
        }

        return { output: `McpSearch requires action 'search' or 'load'.` }
      },
    }

    registry.register(mcpSearch)
    return 1 // Only McpSearch itself was registered
  }
}
