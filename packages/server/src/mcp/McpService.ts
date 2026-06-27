import { loadSettings, setMcpServerInSettings, type McpServerConfig } from '@zuse/core'
import type { McpServerInfo } from '@zuse/protocol'

export interface McpServiceDeps {
  /** Live connected servers + tools (the daemon's McpManager.servers). Default: none connected. */
  connectedServers?: () => Array<{ name: string; tools: Array<{ name: string; description?: string }> }>
  /** Servers that failed to connect at startup. */
  failed?: Array<{ name: string; error: string }>
  /** Read configured mcpServers. Default: loadSettings().mcpServers. */
  loadConfigured?: () => Record<string, McpServerConfig>
  /** settings file basePath for writes. Default: global (~/.zuse/settings.json). */
  settingsBasePath?: string
}

/**
 * MCP management (M4): a read view that merges the configured servers (from settings) with the
 * daemon's live connection status + tools, plus config add/remove (surgical JSONC write).
 * Connections themselves are owned by the daemon's McpManager and established at startup, so
 * config changes take effect on the next restart (status 'configured' until then).
 */
export class McpService {
  constructor(private readonly deps: McpServiceDeps = {}) {}

  private configured(): Record<string, McpServerConfig> {
    if (this.deps.loadConfigured) return this.deps.loadConfigured()
    return loadSettings().mcpServers ?? {}
  }

  list(): McpServerInfo[] {
    const configured = this.configured()
    const connected = new Map((this.deps.connectedServers?.() ?? []).map((s) => [s.name, s.tools]))
    const failed = new Map((this.deps.failed ?? []).map((f) => [f.name, f.error]))

    const names = new Set<string>([...Object.keys(configured), ...connected.keys(), ...failed.keys()])
    const out: McpServerInfo[] = []
    for (const name of names) {
      const cfg = configured[name]
      const status: McpServerInfo['status'] = connected.has(name) ? 'connected' : failed.has(name) ? 'failed' : 'configured'
      out.push({
        name,
        status,
        command: cfg?.command,
        args: cfg?.args,
        error: failed.get(name),
        tools: connected.get(name) ?? [],
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Add (or overwrite) a server config. Takes effect on restart. */
  add(name: string, config: McpServerConfig): void {
    setMcpServerInSettings(name, config, this.deps.settingsBasePath)
  }

  /** Remove a server config. Takes effect on restart (already-connected stays until then). */
  remove(name: string): void {
    setMcpServerInSettings(name, null, this.deps.settingsBasePath)
  }
}
