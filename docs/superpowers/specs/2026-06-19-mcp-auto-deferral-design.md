# MCP Auto-Deferral

> Date: 2026-06-19
> Status: Approved

## Problem

When many MCP servers are connected with dozens of tools, their descriptions consume a large portion of the context window on every API call. CC solves this by auto-deferring MCP tools when their total description exceeds 10% of the context window, replacing them with a search tool.

## Solution

Add a threshold check to `McpManager.registerTools`. When total MCP tool description size exceeds 10% of the context window (in estimated tokens), register a single `McpSearch` tool instead of individual MCP tools. The model uses McpSearch to discover and load tools on demand.

## Threshold Logic

```ts
registerTools(registry, contextWindowTokens?): number
```

- Collect all MCP tools from all connected servers
- Sum their description lengths (chars), divide by 4 to estimate tokens
- If `estimatedTokens > contextWindowTokens * 0.1`, use deferred mode
- If `contextWindowTokens` not provided, never defer (safe default)
- Caller (`useConversation.ts`) passes `resolveContextWindow(settings, providerId, model)`

## McpSearch Tool

Registered in deferred mode instead of individual MCP tools.

### Description

Contains a listing of all available MCP tools (name + first 80 chars of description) so the model can see what's available without the full descriptions consuming context.

### Input Schema

```ts
{
  action: { type: 'string', enum: ['search', 'load'] },
  query: { type: 'string', description: 'search: keyword to match against tool names and descriptions' },
  tool: { type: 'string', description: 'load: exact tool name to activate (e.g. mcp__serverName__toolName)' },
}
```

### Behavior

**search**: Case-insensitive keyword match against deferred tool names and descriptions. Returns matching tools with full descriptions.

**load**: Registers the requested tool into the live registry. Returns confirmation message. The tool becomes callable on the model's next turn (because toolDefs are re-read each turn).

### Error Messages

- Missing action: `"McpSearch requires action 'search' or 'load'."`
- search with no query: `"Missing 'query' for search."`
- search with no matches: `"No MCP tools matched '{query}'. Available: {names}"`
- load with no tool: `"Missing 'tool' name to load."`
- load unknown tool: `"Unknown MCP tool: {name}. Available: {names}"`
- load already loaded: `"Tool {name} is already loaded and callable."`

## agent.ts: Dynamic toolDefs

Move `registry.getDefinitions(settings.tools)` from outside the agent loop to inside it (first line of each turn iteration). This makes newly registered tools (via McpSearch load) visible on the next turn.

No behavior change when no dynamic registration happens — registry is stable, `getDefinitions` returns the same result.

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/mcp-registry.ts` | Add threshold logic, `registerDeferred` method, `McpSearch` tool creation |
| `packages/core/src/mcp-registry.test.ts` | Tests: threshold triggers deferred mode, McpSearch search/load, tool becomes callable after load |
| `packages/core/src/agent.ts` | Move `toolDefs` inside loop (1 line) |
| `packages/core/src/agent.test.ts` | Verify dynamic toolDefs works (tool registered mid-loop becomes visible) |
| `packages/tui/src/hooks/useConversation.ts` | Pass contextWindowTokens to `registerTools` |

## Design Decisions

1. **10% threshold (CC alignment)**: Generous enough that small setups (1-2 servers, <10 tools) never trigger deferral
2. **Listing in McpSearch description**: Model doesn't need to search blindly — it sees tool names + short descriptions upfront
3. **load + next-turn visibility**: Simpler than mid-turn injection; model calls McpSearch(load), then calls the tool on the next turn — two turns total
4. **Unknown tool error as safety net**: If model tries to call a deferred tool directly, the "Unknown tool" error lists McpSearch, guiding recovery
5. **readOnly: true for McpSearch**: No side effects beyond registry mutation; no permission prompt needed
