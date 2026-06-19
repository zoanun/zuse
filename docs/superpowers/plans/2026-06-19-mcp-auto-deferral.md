# MCP Auto-Deferral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-defer MCP tools when their total description size exceeds 10% of the context window, replacing them with a single McpSearch tool for on-demand discovery and loading.

**Architecture:** Add threshold check to `McpManager.registerTools`, create McpSearch tool for deferred mode, make agent loop re-read toolDefs each turn so dynamically loaded tools become visible.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Make toolDefs dynamic in agent loop

**Files:**
- Modify: `packages/core/src/agent.ts:130`

- [ ] **Step 1: Write failing test for dynamic toolDefs**

Add to `packages/core/src/agent.test.ts`, after the existing maxTurns tests:

```ts
  it('picks up tools registered mid-loop (dynamic toolDefs)', async () => {
    // First turn: model requests a tool that doesn't exist yet.
    // After the first tool call, we register the new tool.
    // Second turn: model should be able to use the newly registered tool.
    const turn1: StreamEvent[] = [
      { type: 'tool-use', id: 'a', name: 'echo', input: { value: 'first' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]
    const turn2: StreamEvent[] = [
      { type: 'tool-use', id: 'b', name: 'late', input: { value: 'hi' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]
    const turn3: StreamEvent[] = [
      { type: 'text-delta', text: 'done' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
    ]
    const { client } = fakeClient([turn1, turn2, turn3])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    reg.register(echoTool())
    // 'late' tool is NOT registered yet

    // Register 'late' tool after first tool execution (simulating McpSearch load)
    let firstToolDone = false
    const lateTool = {
      name: 'late',
      description: 'A late-registered tool',
      inputSchema: { type: 'object' as const, properties: { value: { type: 'string' } }, required: ['value'] },
      async run(input: unknown) {
        return { output: `late: ${(input as { value: string }).value}` }
      },
    }

    const events: StreamEvent[] = []
    for await (const event of runAgent({
      conversation: conv,
      client,
      registry: reg,
      userText: 'test dynamic',
      config,
      cwd: '.',
      signal,
    })) {
      events.push(event)
      // After first tool result, register the late tool
      if (event.type === 'tool-result' && !firstToolDone) {
        firstToolDone = true
        reg.register(lateTool)
      }
    }

    // The late tool should have been called successfully (not "Unknown tool")
    const lateResult = events.find(
      (e) => e.type === 'tool-result' && e.name === 'late',
    )
    expect(lateResult).toBeTruthy()
    if (lateResult && lateResult.type === 'tool-result') {
      expect(lateResult.is_error).toBe(false)
      expect(lateResult.output).toContain('late: hi')
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/agent.test.ts -t "picks up tools registered mid-loop"`
Expected: FAIL — 'late' tool returns "Unknown tool" because toolDefs is read once.

- [ ] **Step 3: Move toolDefs inside the loop**

In `packages/core/src/agent.ts`, find line 130:

```ts
  const toolDefs = registry.getDefinitions(settings.tools)
```

Move it inside the `for` loop, as the first line of the loop body (after line `for (let turn = 0; turn < maxTurns; turn++) {`):

```ts
  for (let turn = 0; turn < maxTurns; turn++) {
    const toolDefs = registry.getDefinitions(settings.tools)
```

Delete the old line 130.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/agent.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "feat(agent): re-read toolDefs each turn for dynamic tool registration"
```

---

### Task 2: Add McpSearch tool and deferred registration

**Files:**
- Modify: `packages/core/src/mcp-registry.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/mcp-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ToolRegistry } from './tool.js'
import { McpManager } from './mcp-registry.js'

// We can't easily test with real MCP servers, so test the public interface
// by checking registerTools behavior with contextWindowTokens parameter.

describe('McpManager.registerTools', () => {
  it('accepts optional contextWindowTokens parameter', () => {
    const mgr = new McpManager()
    const reg = new ToolRegistry()
    // No connected servers — should return 0 regardless
    expect(mgr.registerTools(reg, 100000)).toBe(0)
    expect(mgr.registerTools(reg)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/mcp-registry.test.ts`
Expected: FAIL — `registerTools` doesn't accept a second argument.

- [ ] **Step 3: Implement threshold logic and McpSearch tool**

Replace the entire `registerTools` method and add helper methods in `packages/core/src/mcp-registry.ts`:

```ts
  /** Short description for McpSearch listing (name + first 80 chars). */
  private static toolListing(zuseToolName: string, description: string): string {
    const short = description.length > 80 ? description.slice(0, 80) + '…' : description
    return `- ${zuseToolName}: ${short}`
  }

  /**
   * Collect all MCP tools from all connected servers as { zuseToolName, tool, description }.
   */
  private collectAllTools(): Array<{
    zuseToolName: string
    serverName: string
    toolDef: { name: string; description?: string; inputSchema: unknown }
    client: McpClient
  }> {
    const all: Array<{
      zuseToolName: string
      serverName: string
      toolDef: { name: string; description?: string; inputSchema: unknown }
      client: McpClient
    }> = []
    for (const [serverName, client] of this.clients) {
      for (const toolDef of client.tools) {
        all.push({
          zuseToolName: `mcp__${serverName}__${toolDef.name}`,
          serverName,
          toolDef,
          client,
        })
      }
    }
    return all
  }

  private buildMcpTool(
    entry: { zuseToolName: string; serverName: string; toolDef: { name: string; description?: string; inputSchema: unknown }; client: McpClient },
  ): Tool {
    const { zuseToolName, serverName, toolDef, client } = entry
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
          return {
            output: `MCP tool call failed: ${msg}. Do not retry immediately — try an alternative approach, or ask the user to check the MCP server.`,
            isError: true,
          }
        }
      },
    }
  }

  registerTools(registry: ToolRegistry, contextWindowTokens?: number): number {
    const allTools = this.collectAllTools()
    if (allTools.length === 0) return 0

    // Check if total description size exceeds 10% of context window
    const totalDescChars = allTools.reduce(
      (sum, t) => sum + (t.toolDef.description?.length ?? 0), 0,
    )
    const CHARS_PER_TOKEN = 4
    const thresholdChars = contextWindowTokens
      ? contextWindowTokens * 0.1 * CHARS_PER_TOKEN
      : Infinity

    if (totalDescChars > thresholdChars) {
      return this.registerDeferred(registry, allTools)
    }
    return this.registerDirect(registry, allTools)
  }

  private registerDirect(
    registry: ToolRegistry,
    allTools: ReturnType<McpManager['collectAllTools']>,
  ): number {
    let count = 0
    for (const entry of allTools) {
      if (registry.get(entry.zuseToolName)) continue
      registry.register(this.buildMcpTool(entry))
      count++
    }
    return count
  }

  private registerDeferred(
    registry: ToolRegistry,
    allTools: ReturnType<McpManager['collectAllTools']>,
  ): number {
    // Build listing for McpSearch description
    const listing = allTools
      .map((t) => McpManager.toolListing(
        t.zuseToolName,
        t.toolDef.description ?? t.toolDef.name,
      ))
      .join('\n')

    // Build a lookup map for load
    const deferred = new Map<string, (typeof allTools)[number]>()
    for (const entry of allTools) {
      deferred.set(entry.zuseToolName, entry)
    }

    const self = this
    const mcpSearch: Tool = {
      name: 'McpSearch',
      description:
        'Search and load MCP tools on demand. MCP tools are deferred to save context window space.\n' +
        'Use action "search" to find tools by keyword, or action "load" to activate a tool for use.\n' +
        'Available MCP tools:\n' + listing,
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'load'],
            description: 'search: find tools by keyword. load: activate a tool for calling.',
          },
          query: {
            type: 'string',
            description: 'For search: keyword to match against tool names and descriptions.',
          },
          tool: {
            type: 'string',
            description: 'For load: exact tool name to activate (e.g. mcp__serverName__toolName).',
          },
        },
        required: ['action'],
      },
      readOnly: true,

      async run(input: unknown) {
        const { action, query, tool: toolName } = input as {
          action?: string; query?: string; tool?: string
        }
        const names = [...deferred.keys()].join(', ')

        if (action === 'search') {
          if (!query) {
            return { output: `Missing "query" for search. Available tools: ${names}`, isError: true }
          }
          const q = query.toLowerCase()
          const matches = [...deferred.entries()]
            .filter(([name, entry]) =>
              name.toLowerCase().includes(q) ||
              (entry.toolDef.description ?? '').toLowerCase().includes(q),
            )
            .map(([name, entry]) =>
              `${name}: ${entry.toolDef.description ?? '(no description)'}`,
            )
          if (matches.length === 0) {
            return { output: `No MCP tools matched "${query}". Available: ${names}` }
          }
          return { output: matches.join('\n\n') }
        }

        if (action === 'load') {
          if (!toolName) {
            return { output: `Missing "tool" name to load. Available: ${names}`, isError: true }
          }
          if (registry.get(toolName)) {
            return { output: `Tool ${toolName} is already loaded and callable.` }
          }
          const entry = deferred.get(toolName)
          if (!entry) {
            return { output: `Unknown MCP tool: ${toolName}. Available: ${names}`, isError: true }
          }
          registry.register(self.buildMcpTool(entry))
          return { output: `Tool ${toolName} loaded. You can now call it in your next tool use.` }
        }

        return { output: `McpSearch requires action "search" or "load".`, isError: true }
      },
    }

    registry.register(mcpSearch)
    return 1 // registered McpSearch only
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/mcp-registry.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/mcp-registry.ts packages/core/src/mcp-registry.test.ts
git commit -m "feat(mcp): auto-defer tools when description exceeds 10% of context window"
```

---

### Task 3: Wire contextWindowTokens from caller

**Files:**
- Modify: `packages/tui/src/App.tsx:76`

- [ ] **Step 1: Pass contextWindowTokens to registerTools**

In `packages/tui/src/App.tsx`, find line 76:

```ts
if (connected.length > 0) mgr.registerTools(registry)
```

Change to:

```ts
if (connected.length > 0) {
  const sel = resolveModelSelection(resolved)
  const ctxWindow = resolveContextWindow(resolved, sel.providerId, sel.model)
  mgr.registerTools(registry, ctxWindow)
}
```

The imports `resolveModelSelection` and `resolveContextWindow` are already available — `resolveContextWindow` is imported at line 15, and `resolveModelSelection` needs to be added to the import. Check the existing import from `@zuse/core`:

```ts
import { getDefaultMaxTokens, getWebSearchConfig, loadSettings, resolveContextWindow, DEFAULT_PROVIDER_ID, type Conversation, type ResolvedSettings } from '@zuse/core'
```

Add `resolveModelSelection` to this import:

```ts
import { getDefaultMaxTokens, getWebSearchConfig, loadSettings, resolveContextWindow, resolveModelSelection, DEFAULT_PROVIDER_ID, type Conversation, type ResolvedSettings } from '@zuse/core'
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/App.tsx
git commit -m "feat(tui): pass context window to MCP registerTools for auto-deferral threshold"
```

---

### Task 4: Export McpSearch-related types and verify

**Files:**
- Modify: `packages/core/src/index.ts` (if needed)

- [ ] **Step 1: Check if McpManager is re-exported**

Run: `grep -n "McpManager\|mcp-registry" packages/core/src/index.ts`

If it re-exports `McpManager`, the new `registerTools` signature is automatically available. If not, add the export.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS — no regressions.

- [ ] **Step 3: Commit (if index.ts changed)**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export updated McpManager with auto-deferral support"
```
