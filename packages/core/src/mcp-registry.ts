import { McpClient, type McpServerConfig } from './mcp-client.js'
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

  registerTools(registry: ToolRegistry): number {
    let count = 0
    for (const [serverName, client] of this.clients) {
      for (const toolDef of client.tools) {
        const zuseToolName = `mcp__${serverName}__${toolDef.name}`
        if (registry.get(zuseToolName)) continue

        const tool: Tool = {
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

        registry.register(tool)
        count++
      }
    }
    return count
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect()
    }
    this.clients.clear()
  }

  get serverNames(): string[] {
    return [...this.clients.keys()]
  }
}
