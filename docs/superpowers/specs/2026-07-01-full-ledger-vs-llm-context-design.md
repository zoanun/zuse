# Decoupling the full conversation ledger from the LLM context

**Date:** 2026-07-01
**Branch:** `s4-history-search`
**Status:** Approved design → implementation

## Problem

`SessionManager.conversation` is a single `Conversation` that serves three roles at once:
display (the web snapshot), persistence + search (autosave writes it to disk, `SearchService`
reads it), and the LLM context (what `runAgent` sends). When context usage crosses the
threshold, `compact()` calls `applyCompaction`, which **replaces** the ledger with
`[summary, ...recent]` — physically dropping the folded-away messages. Because the three roles
share one object, compaction destroys the old turns everywhere: they vanish from the display,
from disk, and from search. The user can no longer review or search what was said before a
compaction.

Consequence already observed: a live session shows more than a reloaded/searched one (the client
keeps messages it already rendered, but disk/search only have the compacted record), and search
hits into a since-compacted live session can mis-align (finding #5).

## Goal

Keep the **full** conversation available for display and search — always, including pre-compaction
turns — while sending the LLM only the compacted view (last summary + messages after it). In
short: separate "the archive for humans" from "the context window for the model".

## Scope decisions (agreed)

- **Daemon only.** Change lives in `packages/server`'s `SessionManager`. `core`'s compaction
  functions and `runAgent` are **untouched**; the TUI keeps its current (physical-fold) behavior.
  No shared-code divergence risk. Trade-off: the TUI does not gain this behavior.
- **No storage cap (YAGNI).** The full ledger is retained in full, persisted in full, and sent in
  full in the snapshot. It is a local single-user tool over plain text; revisit only if a real
  session becomes slow.
- **Implementation shape B1-a:** one full ledger (never folded) + a per-turn transient compacted
  view. Not a dual live-ledger design.

## Design

### Data model

`SessionManager.conversation` becomes the **full ledger — never folded**. Add:

```ts
private compaction: { summaryText: string; cutIndex: number } | null = null
```

- `cutIndex` is an index **into the full ledger**; `summaryText` summarizes `ledger[0..cutIndex)`.
- `null` = never compacted.

### Compaction (`compact()` rewrite)

- Find the cut on the **current context view** (`[summaryMsg?, ...ledger.slice(prevCut)]`) with
  `findCompactionCutByBudget`, then translate the view-coordinate cut to a full-ledger index
  `newCutIndex` (`prevCut + viewCut − (summary ? 1 : 0)`).
- Iterative summary: `previousSummary = this.compaction?.summaryText` (fed straight into
  `summarizeForCompaction` / `buildIterativeSummaryPrompt`) — no longer read from the ledger's
  first message via `extractPreviousSummary`.
- Do **not** call `applyCompaction`. Instead set `this.compaction = { summaryText, cutIndex: newCutIndex }`
  and reset `contextTokens = undefined` (re-measured next turn).
- Memory-flush (`splitMemoryCandidates` + Memory tool) behavior is preserved unchanged.
- `cutIndex` advances monotonically across repeated compactions.

### Turn flow (`submit()`)

1. Auto-compaction trigger unchanged (it now only updates `this.compaction`).
2. Build the **transient compacted view**:
   `view = new Conversation([summaryMsg(compaction.summaryText), ...ledger.slice(compaction.cutIndex)])`,
   seeded with `ledger.totalUsage`. When `compaction === null`, `view = this.conversation` (the
   ledger itself).
3. `runAgent({ conversation: view, ... })` — **`core/runAgent` is unchanged**; it reads `view`
   to build the request and appends the turn's new messages to `view`.
4. On turn end, append the tail the turn produced —
   `view.getMessages().slice(preLen)` where `preLen` = the view's length before `runAgent` — back
   onto `this.conversation` (the full ledger), and carry the turn's usage onto the ledger
   (`ledger.totalUsage = view.totalUsage`, or add the delta).
5. Failover / resend / abort branches keep their current structure, operating on
   "the ledger + a view rebuilt from the latest `this.compaction`". A resend rebuilds the view.

### Checkpoints

`checkpointIndex = this.conversation.length` (full-ledger coordinate). The ledger never folds, so
checkpoint indices are **stable**: `remapCheckpoints` is no longer needed on the daemon side
(revert truncates the ledger at the checkpoint index as before). `remapCheckpoints` stays in the
codebase for the TUI.

### Persistence + protocol

- `SessionRecord` gains an optional field `compaction?: { summaryText: string; cutIndex: number }`.
  `SessionService.persist` writes `this.compaction`.
- `getOrLoad` restores `conversation` from the full `rec.messages` and `this.compaction =
  rec.compaction ?? null`. `createSession` is threaded to accept the restored compaction meta.
- **No WS protocol change.** `getState()` already sends `this.conversation`'s messages — now the
  full ledger — so the web client receives the entire history automatically. The summary text is
  metadata, not a ledger message, so it is not sent as a chat message.

### Search / display / finding #5

- Persisted `messages` is the full ledger → search covers all history including pre-compaction
  turns. The summary text is not in the ledger and is not searched.
- The client renders the full snapshot → "review what was said earlier" works, and the live view
  matches the reloaded/searched view (the earlier inconsistency is gone).
- Search index == display index (both the full ledger) → **finding #5 (jump mis-alignment) is
  eliminated**.

### Migration / compatibility

- Sessions already compacted by the old logic have **permanently lost** their pre-compaction text;
  it cannot be recovered. The new behavior applies to compactions from here on.
- Records without the `compaction` field load as `null` and behave correctly.
- `applyCompaction` / `extractPreviousSummary` / `remapCheckpoints` remain in `core` (TUI uses
  them); the daemon simply stops calling them.

## Testing

`SessionManager` unit tests:
- After a compaction, the ledger still contains **all** messages; `this.compaction` holds the
  correct `{summaryText, cutIndex}`.
- The request handed to the model client (the view) contains only `[summary, ...tail]`, not the
  folded-away originals.
- A second (iterative) compaction advances `cutIndex` monotonically and updates the summary.
- The turn's new tail is appended back to the full ledger exactly once; usage accumulates
  correctly (parity with pre-change totals).
- After `getOrLoad` (restart), `this.compaction` is restored and the next turn's view is rebuilt
  correctly.
- Revert by checkpoint truncates the full ledger at the stable index.

Regression: existing `SessionManager` / `SessionService` / `search` / `http` suites stay green;
the web suite is unaffected (no web change). The TUI is untouched.

## Risk notes

The two error-prone spots, pinned by tests: (1) the turn-tail append-back and usage carry-over
must produce a ledger identical to the old physical-fold result minus the folding; (2) the view
must always be rebuilt from the **latest** `this.compaction` on resend/failover paths.
