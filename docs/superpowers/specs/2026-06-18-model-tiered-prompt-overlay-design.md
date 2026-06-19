# Model-Tiered Prompt Overlay

> Date: 2026-06-18
> Status: Approved

## Problem

Zuse's system prompt (`DEFAULT_SYSTEM_PROMPT`) treats all models identically. Claude models follow instructions well with the current concise prompt, but cheaper/weaker models (DeepSeek, Qwen, GPT-4o-mini, Gemini Flash, GLM, etc.) exhibit recurring failure modes:

1. **Say-but-don't-do** — model describes what it would do instead of calling tools
2. **Memory-based answers** — answers factual questions from training data instead of using tools
3. **Fabricated output** — invents plausible-looking data when a tool call fails
4. **Premature completion** — stops after a stub or plan instead of finishing the task

These failure modes are well-documented across peer projects (Hermes, OpenClaw, OpenCode) and addressed with explicit enforcement prompts.

## Solution: Two-Tier Model Classification

Detect the model family from `modelId` and conditionally inject an enforcement overlay for non-Claude models.

### Tier 1: Claude Family (no overlay)
- Detection: `modelId.toLowerCase()` contains `'claude'` or `'anthropic'`
- Behavior: identical to current — no extra tokens, prompt cache prefix unchanged

### Tier 2: All Other Models (enforcement overlay)
- Detection: everything that isn't Tier 1
- Behavior: append ~250 tokens of XML-structured enforcement blocks

## Overlay Content

Four XML blocks, each targeting one failure mode:

```xml
<tool_use_enforcement>
You MUST use your tools to take action — do not describe what you would do
without actually doing it. When you say you will perform an action, you MUST
immediately make the corresponding tool call in the same response. Never end
your turn with a promise of future action — execute it now.
Every response should either (a) contain tool calls that make progress, or
(b) deliver a final result. Responses that only describe intentions are not acceptable.
</tool_use_enforcement>

<mandatory_tool_use>
NEVER answer these from memory or mental computation — ALWAYS use a tool:
- Arithmetic, math, calculations → Bash
- File contents, sizes, line counts → Read or Bash
- Current time, date, timezone → Bash
- System state (OS, disk, processes) → Bash
- Git history, branches, diffs → Bash
</mandatory_tool_use>

<anti_fabrication>
NEVER substitute plausible-looking fabricated output (made-up data, invented
file contents, synthesised command output) for results you could not actually
produce. If a tool or command fails, report the blocker honestly and try an
alternative. Fabricating a result is always worse than admitting failure.
</anti_fabrication>

<completion_contract>
Treat the task as incomplete until every requested item is handled.
Do not stop after writing a stub or a single command. Keep working until you
have actually produced the requested result, then report what real execution
returned. Before finalizing, verify: does the output satisfy every stated
requirement? Are factual claims backed by tool outputs?
</completion_contract>
```

## maxTurns Stop Text

Replace the current soft stop message with a forceful one:

```
[CRITICAL: Maximum tool turns (N) reached. Tools are now disabled.
Do NOT attempt any more tool calls. Summarize what was accomplished
and what remains, then end your response.]
```

## Interface Changes

### `buildSystemPrompt` (packages/core/src/prompt.ts)

```ts
// Before
export function buildSystemPrompt(
  env: AgentEnvironment,
  sections: Array<{ title: string; content: string }> = [],
): string

// After
export function buildSystemPrompt(
  env: AgentEnvironment,
  sections: Array<{ title: string; content: string }> = [],
  modelId?: string,
): string
```

New helper:

```ts
function isClaudeFamily(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return id.includes('claude') || id.includes('anthropic')
}
```

Insertion point: overlay appended after the environment block, before user/project sections. This keeps the stable prefix (identity + env) unchanged for prompt cache, while the overlay is part of the per-model-variant cache key.

New exports:

```ts
export const NON_CLAUDE_ENFORCEMENT_OVERLAY: string  // the overlay text
export { isClaudeFamily }                             // for tests
```

### `agent.ts` (packages/core/src/agent.ts)

Replace the maxTurns stop text:

```ts
// Before
`[Stopped: reached max turns (${maxTurns}).]`

// After — use new constant
MAX_TURNS_STOP_TEXT(maxTurns)
```

Export the constant for testing:

```ts
export const MAX_TURNS_STOP_TEXT = (n: number) =>
  `[CRITICAL: Maximum tool turns (${n}) reached. Tools are now disabled. ` +
  `Do NOT attempt any more tool calls. Summarize what was accomplished ` +
  `and what remains, then end your response.]`
```

### `useConversation.ts` (packages/tui/src/hooks/useConversation.ts)

Pass `currentModel` to `buildSystemPrompt` and add it to the useMemo dependency array:

```ts
const promptInfo = useMemo(() => {
  const sections = loadPromptSections(os.homedir(), cwd)
  return {
    systemPrompt: buildSystemPrompt(
      { platform, osVersion, shell, cwd, date },
      sections,
      currentModel,   // NEW
    ),
    memoryCount,
  }
}, [cwd, currentModel])  // NEW: added currentModel
```

First render: `currentModel === 'unknown'` → `!isClaudeFamily('unknown')` → overlay injected. After provider resolves, Claude users get a re-computation that drops the overlay (before any message is sent). Non-Claude users keep it. No impact on prompt cache (cache established on first actual API call, after model is resolved).

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/prompt.ts` | Add `modelId` param, `isClaudeFamily()`, `NON_CLAUDE_ENFORCEMENT_OVERLAY`, injection logic |
| `packages/core/src/prompt.test.ts` | Tests: overlay present for non-Claude, absent for Claude, absent when no modelId |
| `packages/core/src/agent.ts` | Replace maxTurns stop text with `MAX_TURNS_STOP_TEXT` |
| `packages/core/src/agent.test.ts` | Test: maxTurns message contains new text |
| `packages/tui/src/hooks/useConversation.ts` | Pass `currentModel`, add dependency |

## Design Decisions

1. **Two-tier, not three-tier**: All non-Claude models share the same overlay. Hermes' experience shows GPT/Gemini/DeepSeek/Qwen have similar failure modes. The ~250 extra tokens are harmless to strong models and essential for weak ones.
2. **XML tags**: Weaker models recognize XML structural boundaries better than prose paragraphs (observed by Hermes and OpenClaw).
3. **English only**: Matches DEFAULT_SYSTEM_PROMPT language. Models follow English instructions more reliably.
4. **Overlay after env, before sections**: User/project instructions (SYSTEM.md, ZUSE.md) come last and can override overlay behavior if needed.
5. **No model-specific tuning**: Avoids a maintenance burden of tracking model name patterns. If a specific model needs different treatment in the future, the `isClaudeFamily` check can be extended to a more granular classifier.
