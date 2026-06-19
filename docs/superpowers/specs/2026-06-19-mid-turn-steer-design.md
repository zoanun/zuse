# Mid-Turn User Steering (STEER)

> Date: 2026-06-19
> Status: Draft — needs implementation planning

## Problem

When the model is executing a long multi-tool turn, the user has no way to course-correct without aborting (Esc). Esc kills the entire turn, losing all progress. The user must re-explain the task from scratch.

## Solution

Allow the user to send a message while the model is working. The message is queued and injected into the next tool_result before it's fed back to the model. The model sees it as a direct user instruction and adjusts course immediately — no interruption, no progress loss.

## Prior Art Comparison

| Aspect | CC (Claude Code) | Hermes |
|--------|-----------------|--------|
| **Marker** | `<system-reminder>` tag (reuses existing infra) | Custom `[OUT-OF-BAND USER MESSAGE]` markers |
| **Injection** | System-reminder injection into context | Appended to tool_result content |
| **Prompt text** | "IMPORTANT: you MUST address the user's message" | System prompt teaches model to trust marker |
| **Security** | `<system-reminder>` is a trusted system tag | Explicit "ignore lookalikes" instruction |
| **Complexity** | Low — reuses existing mechanism | High — custom markers, mutex queue, 3 TUI modes |
| **Advantage** | Simple, model naturally trusts system tags | More explicit, works with any model |

**Decision: Follow CC's approach** — simpler, leverages the `<system-reminder>` pattern. Zuse already has system-level message injection infrastructure; we don't need to invent a new marker format.

## Architecture

Three layers:

### 1. TUI Layer (input during execution)

Currently, the input box is disabled while the model is working (`isThinking: true`). Change:
- Keep the input box active during model execution
- When user submits while a turn is in progress, push the text into a `steerQueue` ref (not a regular message)
- Visual indicator: different input prompt (e.g., `⚡ Steer...` instead of `› Input...`) so the user knows they're steering, not starting a new turn
- Show the steer text as a subtle system message bubble (so user sees their message was received)

### 2. Agent Loop (injection point)

In `agent.ts`, after a tool execution completes and before the tool_result is staged:

```ts
const steer = opts.consumeSteer?.()
if (steer) {
  result.output += `\n\n[USER MESSAGE — sent while you were working]\n${steer}\n[/USER MESSAGE]\nIMPORTANT: Address the user's message above. It takes priority over your current task. You may continue your current work after acknowledging it, or change direction if they asked you to.`
}
```

New `RunAgentOptions` field:
```ts
consumeSteer?: () => string | null
```

The caller (`useConversation.ts`) provides this callback. It drains the steer queue — returns all queued messages concatenated, or null if empty.

### 3. No System Prompt Change Needed

Unlike Hermes, we don't need to teach the model about a custom marker in the system prompt. The injection text is self-describing:
- `[USER MESSAGE — sent while you were working]` — clear attribution
- `IMPORTANT: Address the user's message above` — explicit instruction
- Injected into tool_result (user role) — naturally trusted by model

This keeps the system prompt clean and avoids wasting tokens on marker documentation.

## Interaction Flow

```
User: "Review all files in src/"
Model: Read(src/auth.ts) → [result]
Model: Read(src/db.ts) → [result]
User types: "skip test files, focus on auth"       ← steer input
Model: Read(src/auth.test.ts) → [result + USER MESSAGE injection]
Model: "Got it, skipping test files." → Read(src/auth-middleware.ts) → ...
```

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/agent.ts` | Add `consumeSteer` to RunAgentOptions, inject after tool result |
| `packages/tui/src/hooks/useConversation.ts` | Add steerQueue ref, provide consumeSteer callback, show steer bubble |
| `packages/tui/src/App.tsx` or `InputBox.tsx` | Allow input during execution, route to steer queue vs normal submit |

## Design Decisions

1. **Append to tool_result**: Only injection point that maintains role alternation (tool_result is already role=user). Same approach as both CC and Hermes.
2. **Self-describing injection**: The injection text itself tells the model what it is and what to do. No system prompt overhead.
3. **Queue + drain**: Tool execution is async; steers wait for the next tool to finish. Multiple steers concatenate with newlines.
4. **No steer during text generation**: Only during tool execution. If model is generating text (no tool call), Esc is the only option.
5. **Visual steer mode**: Different input prompt so user knows they're steering, not starting a new turn.
6. **CC-style simplicity over Hermes-style completeness**: We don't need three TUI modes, mutex queues, or 619 lines of tests. Start simple, iterate if needed.

## Edge Cases

- **User steers but model finishes before next tool**: Steer is lost (model already stopped). Acceptable — user can just say it in the next turn.
- **Multiple steers queued**: Concatenate with newlines into one injection.
- **Steer during parallel tool execution**: Inject into the first tool result that returns after the steer is queued.
- **Empty steer**: Ignore (don't inject empty marker).
- **Steer contains prompt injection attempts**: The injection is inside tool_result, which the model already treats as untrusted data. Adding `[USER MESSAGE]` framing doesn't change the trust level — it's the same as any other tool output. The `IMPORTANT:` instruction gives it priority but the model still applies its own judgment.
