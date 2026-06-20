# Workflow Resume (Checkpoint Resume)

> Date: 2026-06-20
> Status: Draft — pending user review

## Problem

When a workflow with many agent() calls fails partway through (network error, API quota, abort), all progress is lost. The entire workflow must be re-run from scratch, wasting time and tokens.

## Solution

Persist each agent() call's input fingerprint and result to a journal file on disk. On resume, compare fingerprints — cached results are returned instantly, only changed/new calls execute.

## Journal File

Path: `<cwd>/.zuse/workflow-journal/<runId>.jsonl`

Each line is one agent call record:
```jsonl
{"hash":"abc123","prompt":"review for bugs","opts":{"label":"bugs"},"result":"found 2 issues","tokens":150}
{"hash":"def456","prompt":"review for security","opts":{"label":"security"},"result":"all clear","tokens":80}
```

## Cache Key

```ts
hash = SHA-256(JSON.stringify({ prompt, opts: { label, model, maxTurns, schema, allowedTools } }))
```

Prompt or any opts field changes → hash differs → re-execute.

## agent() Modification

```ts
async function agent(prompt, opts?) {
  const hash = computeHash(prompt, opts)

  // Resume: check journal cache
  const cached = journal.get(hash)
  if (cached) {
    tokensSpent += cached.tokens
    agentCount++
    return cached.result
  }

  // Execute normally (existing logic)
  const result = await executeAgent(prompt, opts)

  // Persist to journal
  journal.append({ hash, prompt, opts, result, tokens: resultTokens })

  return result
}
```

## createWorkflow Changes

New optional fields in `WorkflowContext`:
```ts
interface WorkflowContext {
  // ...existing...
  resumeFromRunId?: string   // source run id to resume from
  journalDir?: string        // override journal directory (for tests)
}
```

New return value:
```ts
const { agent, parallel, pipeline, budget, runId } = createWorkflow(ctx)
```

When `resumeFromRunId` is provided, the journal file for that run is read into a Map. New execution produces a new journal (new runId), but matching calls skip execution.

## Cache Hit Rule

Sequential comparison: the journal is an ordered list. The Nth agent() call in the new run is compared against the Nth entry in the journal. If the hash matches, the cached result is used. If it doesn't match, that entry and all subsequent entries are invalidated (re-executed).

This is simpler and more correct than hash-only matching:
- Prevents out-of-order cache hits (agent A's result used for agent B)
- Automatically invalidates downstream calls when an upstream call changes
- Matches CC's approach

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/workflow.ts` | Add journal read/write, cache check in agent(), runId generation |
| `packages/core/src/workflow.test.ts` | Tests: cache hit, cache miss on changed prompt, sequential invalidation |

## Design Decisions

1. **JSONL format**: One line per entry, append-only, easy to read/write, human-inspectable
2. **Sequential matching (not hash-only)**: Prevents cross-contamination between different agent calls that happen to have similar prompts
3. **New runId per resume**: Original journal preserved for debugging; new journal captures the resumed run
4. **Journal in project dir**: `.zuse/workflow-journal/` — same pattern as tool output spill, cleaned up with project
5. **No automatic cleanup**: Old journals accumulate; user can delete `.zuse/workflow-journal/` manually
