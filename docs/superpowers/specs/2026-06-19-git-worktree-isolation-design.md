# Git Worktree Isolation for Sub-Agents

> **Date**: 2026-06-19
> **Status**: Design complete, pending implementation
> **Dependencies**: agent-tool.ts (createAgentTool), agent.ts (runAgent/RunAgentOptions), snapshot.ts (SnapshotStore)
> **Reference**: CC's `src/utils/worktree.ts` + `src/tools/AgentTool/AgentTool.tsx`

---

## 1. Problem Statement

When `runInBackground: true`, multiple sub-agents can execute in parallel. But they all
share the same working directory. If two sub-agents write to the same file (Edit, Write,
Bash), they produce corrupted output or silent data loss. Even sequential sub-agents
share the parent's working tree, so a sub-agent that leaves dirty state (partial writes,
uncommitted changes) contaminates subsequent work.

The existing snapshot/checkpoint system (Phase 12) provides *revert* for the parent
session's working tree but does not *isolate* concurrent writers. Isolation and
snapshotting are orthogonal concerns.

**Scope**: This design adds an optional `isolation: 'worktree'` parameter to the Agent
tool that gives each sub-agent its own git worktree, eliminating write conflicts.

## 2. Solution Overview

```
Parent agent (cwd = /repo)
  │
  ├─ Agent({ isolation: 'worktree', prompt: "task A" })
  │    ├─ git worktree add -B worktree-agent-<id> <tmpdir> HEAD
  │    ├─ sub-agent runs with cwd = <tmpdir>
  │    └─ on finish:
  │         ├─ changes? → report worktree path + branch
  │         └─ no changes? → git worktree remove + branch -D
  │
  └─ Agent({ isolation: 'worktree', prompt: "task B" })
       └─ (same lifecycle, different worktree)
```

Each isolated sub-agent gets a fresh git worktree branched from the current HEAD.
The worktree lives in a temp directory under `<repo>/.zuse/worktrees/` (matching CC's
`.claude/worktrees/` convention). The sub-agent's `cwd` points to the worktree; all
file tools (Read, Write, Edit, Glob, Grep) and Bash operate there. When the sub-agent
finishes, the worktree is auto-cleaned if no changes were made, or preserved with its
branch name reported so the parent can merge.

## 3. Agent Tool Parameter Changes

### 3.1 New Input Field

```typescript
interface AgentToolInput {
  prompt: string
  description: string
  model?: string
  allowedTools?: string[]
  runInBackground?: boolean
  // NEW
  isolation?: 'worktree'
}
```

JSON Schema addition:

```json
{
  "isolation": {
    "type": "string",
    "enum": ["worktree"],
    "description": "Isolation mode. \"worktree\" creates a temporary git worktree so the agent works on an isolated copy of the repo."
  }
}
```

The enum is extensible; a future `'remote'` value could launch the agent in a
sandboxed environment. For now only `'worktree'` is supported.

### 3.2 Enhanced Output

When `isolation: 'worktree'` was used, the tool result text is augmented with
structured metadata so the parent agent can act on it:

```
<worktree-result>
  <status>changes_detected</status>
  <worktree-path>/repo/.zuse/worktrees/agent-a1b2c3d4</worktree-path>
  <branch>worktree-agent-a1b2c3d4</branch>
  <diff-stat>
   src/foo.ts | 12 ++++++------
   src/bar.ts |  3 +++
   2 files changed, 9 insertions(+), 6 deletions(-)
  </diff-stat>
</worktree-result>

[sub-agent's original text output]
```

When no changes were detected, the worktree is cleaned up silently and the output
is the sub-agent's text alone (no metadata block).

### 3.3 Validation

- `isolation: 'worktree'` requires the current working directory to be inside a git
  repository. If not, return `{ output: "Cannot create worktree: not in a git
  repository.", isError: true }`.
- `isolation: 'worktree'` with `runInBackground: false` (synchronous) is valid but
  provides less value than background mode. No special restriction.

## 4. Worktree Lifecycle

### 4.1 Create

```
1. Generate a slug: `agent-${crypto.randomUUID().slice(0, 8)}`
2. Validate slug (alphanumeric + hyphen, no path traversal)
3. Determine repo root via `git rev-parse --show-toplevel`
4. Ensure .zuse/worktrees/ is in .git/info/exclude (so worktrees don't pollute
   git status)
5. mkdir -p <repo>/.zuse/worktrees/
6. git worktree add -B worktree-<slug> <repo>/.zuse/worktrees/<slug> HEAD
7. Record headCommit = current HEAD SHA (for change detection later)
```

The `-B` flag (not `-b`) resets the branch if it already exists from a previously
leaked worktree, avoiding "branch already exists" errors without a separate
`git branch -D` call.

### 4.2 Run

```
1. Build sub-agent as today (child registry, child client, system prompt + suffix)
2. Override cwd: pass worktreePath as `cwd` to runAgent()
3. The sub-agent's ToolContext.cwd = worktreePath
4. All file operations resolve paths relative to the worktree
5. Bash commands execute with cwd = worktreePath
6. The sub-agent's snapshot store is NOT created for the worktree
   (worktree is ephemeral; the parent session's checkpoint covers the main repo)
```

### 4.3 Finish (Success)

```
1. Check for changes:
   a. git status --porcelain (in worktree) → uncommitted changes?
   b. git rev-list --count <headCommit>..HEAD (in worktree) → new commits?
   c. Either non-empty → hasChanges = true

2. If hasChanges:
   a. Compute diff-stat: git diff --stat <headCommit>
   b. Keep the worktree and branch intact
   c. Append worktree metadata to sub-agent's result text
   d. Return to parent: the parent agent (or user) decides how to merge

3. If !hasChanges:
   a. git worktree remove --force <worktreePath> (from repo root)
   b. git branch -D worktree-<slug>
   c. Return sub-agent's text output only
```

### 4.4 Finish (Failure / Abort)

```
1. If sub-agent threw or was aborted:
   a. Attempt cleanup: git worktree remove --force <worktreePath>
   b. Attempt: git branch -D worktree-<slug>
   c. Both are best-effort; failures logged but not propagated
   d. Return error result to parent
```

### 4.5 Cleanup Safety

The cleanup function is idempotent: it nulls out worktreeInfo after the first call
(same pattern as CC). A try/finally in the agent execution ensures cleanup runs even
on unexpected errors:

```typescript
let worktreeInfo: WorktreeInfo | null = null
try {
  worktreeInfo = await createWorktree(slug)
  // ... run sub-agent ...
} finally {
  if (worktreeInfo) {
    await cleanupWorktreeIfNeeded(worktreeInfo)
  }
}
```

## 5. New Module: `packages/tools/src/worktree.ts`

A standalone module encapsulating all git worktree operations:

```typescript
export interface WorktreeInfo {
  worktreePath: string
  worktreeBranch: string
  headCommit: string
  gitRoot: string
}

/** Create a worktree under <gitRoot>/.zuse/worktrees/<slug>. */
export async function createWorktree(
  gitRoot: string,
  slug: string,
): Promise<WorktreeInfo>

/** True if the worktree has uncommitted changes or new commits since headCommit. */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean>

/** git diff --stat from headCommit to current worktree state. */
export async function worktreeDiffStat(
  worktreePath: string,
  headCommit: string,
): Promise<string>

/** Remove worktree directory and delete the temporary branch. Best-effort. */
export async function removeWorktree(
  worktreePath: string,
  worktreeBranch: string,
  gitRoot: string,
): Promise<boolean>

/** Find the git repository root from cwd. Returns null if not in a repo. */
export function findGitRoot(cwd: string): string | null

/** Ensure .zuse/worktrees/ is excluded from git status. */
export async function ensureWorktreesDirExcluded(gitRoot: string): Promise<void>
```

All git commands use `execFile` with:
- `timeout: 30_000` (30s hard limit)
- `windowsHide: true`
- `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=''` to prevent credential prompts

## 6. Interaction with Existing Systems

### 6.1 Snapshot/Checkpoint System (Phase 12)

The shadow-git snapshot store (`packages/tools/src/snapshot.ts`) operates on the
main working tree via `--git-dir=~/.zuse/snapshots/<slug>/ --work-tree=<project>`.
It is completely independent of git worktrees:

- **Parent session**: Snapshot store continues to track the main working tree.
  Sub-agent worktrees are under `.zuse/worktrees/` which is gitignored, so
  `git add -A` in the shadow repo does not include worktree files.
- **Sub-agent**: Does NOT get its own snapshot store. Worktrees are ephemeral and
  short-lived (sub-agent max 10 turns); the overhead of maintaining a parallel
  shadow repo is unjustified. If the sub-agent fails, the worktree is cleaned up
  entirely.
- **No checkpoint collision**: The snapshot store's `--git-dir` is keyed by
  `cwdSlug(cwd)`. Even if we later wanted per-worktree snapshots, the different
  `cwd` would route to a separate shadow repo.

### 6.2 read-before-edit (FileReadTracker)

The parent agent and sub-agent currently share the same `FileReadTracker` (see
agent-tool.ts line 111: `tracker: ctx.tracker`). With worktree isolation, the
sub-agent operates on different physical files (different absolute paths), so
sharing the tracker is harmless: the parent's fingerprints are keyed by
`/repo/src/foo.ts` while the sub-agent's are keyed by
`/repo/.zuse/worktrees/<slug>/src/foo.ts`. No collision.

However, for clarity and correctness, an isolated sub-agent SHOULD get its own
fresh `FileReadTracker`. This prevents the tracker from accumulating stale entries
across ephemeral worktrees.

### 6.3 Permission System

The sub-agent inherits the parent's full permission configuration (`settings`,
`sessionAllow`, `canUseTool`). Path-based permission rules (e.g., "allow Edit
for `src/**`") will match against the worktree path. Since the worktree is under
the repo root (`.zuse/worktrees/`), rules anchored to the project root still
apply. Rules using absolute paths may not match; this is acceptable -- the user
can approve interactively.

### 6.4 Tmux Isolation

The existing tmux socket isolation (`tmux-isolation.ts`) is orthogonal. Sub-agents
don't interact with tmux; Bash commands in the worktree use the same tmux socket
as the parent. No changes needed.

### 6.5 Background Agent Notifications

When `runInBackground: true` and `isolation: 'worktree'`, the `onBackground`
callback receives the enhanced result text (including worktree metadata if
changes exist). The parent agent sees the notification and can decide to merge.

## 7. Error Handling

| Scenario | Handling |
|----------|----------|
| Not in a git repo | Return `isError: true` before spawning sub-agent |
| `git worktree add` fails | Return `isError: true` with stderr |
| Sub-agent throws | Cleanup worktree (best-effort), propagate error |
| Sub-agent aborted (Ctrl+C) | Cleanup worktree (best-effort), return abort result |
| `git worktree remove` fails during cleanup | Log warning, leave worktree on disk |
| Branch already exists (leaked) | `-B` flag resets it; no error |
| Credential prompt blocks git | `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=''` prevent hanging |
| Git command timeout | 30s hard timeout on all git operations |

### 7.1 Stale Worktree Cleanup

Leaked worktrees (from killed processes) accumulate under `.zuse/worktrees/`.
A periodic cleanup function (called at session start) can scan for worktrees
matching the ephemeral pattern `agent-<8hex>`, check their mtime, and remove
those older than a threshold (e.g., 7 days) that have no uncommitted changes.

```typescript
export async function cleanupStaleWorktrees(
  gitRoot: string,
  cutoffDate: Date,
): Promise<number>
```

This mirrors CC's `cleanupStaleAgentWorktrees()` with its safety guards:
- Only touches slugs matching `agent-[0-9a-f]{8}`
- Skips worktrees with uncommitted changes
- Skips worktrees with unpushed commits

## 8. Agent Tool Implementation Changes

### 8.1 Modified `createAgentTool` Signature

```typescript
export interface AgentToolDeps {
  registry: ToolRegistry
  getClient: () => ModelClient
  settings: ResolvedSettings
  getSystemPrompt: () => string
  sessionAllow?: string[]
  canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>
  onBackground?: (description: string, result: string) => void
  // NEW: current working directory getter (needed to find git root)
  getCwd: () => string
}
```

### 8.2 Modified `run()` Flow

```
AgentTool.run(input, ctx)
  │
  ├─ 1. Validate input (existing)
  │
  ├─ 2. Build child client (existing)
  │
  ├─ 3. Build child registry (existing)
  │
  ├─ 4. NEW: If isolation === 'worktree':
  │     ├─ Find git root from ctx.cwd
  │     ├─ Generate slug: agent-${randomUUID().slice(0, 8)}
  │     ├─ createWorktree(gitRoot, slug) → worktreeInfo
  │     └─ Override effectiveCwd = worktreeInfo.worktreePath
  │
  ├─ 5. Execute sub-agent with effectiveCwd (existing, but cwd may differ)
  │
  ├─ 6. NEW: If worktreeInfo:
  │     ├─ hasWorktreeChanges(worktreePath, headCommit)?
  │     │   ├─ yes: append metadata to result, keep worktree
  │     │   └─ no: removeWorktree(path, branch, gitRoot)
  │     └─ On error: removeWorktree (best-effort)
  │
  └─ 7. Return result (existing, possibly augmented)
```

### 8.3 FileReadTracker for Isolated Agents

When `isolation: 'worktree'`, create a fresh tracker instead of sharing the parent's:

```typescript
import { createFileTracker } from '@zuse/core'

const childTracker = worktreeInfo ? createFileTracker() : ctx.tracker
```

## 9. Files Changed

| File | Change |
|------|--------|
| `packages/tools/src/worktree.ts` | **NEW** - Git worktree create/remove/change-detect operations |
| `packages/tools/src/worktree.test.ts` | **NEW** - Unit tests for worktree module |
| `packages/tools/src/agent-tool.ts` | Add `isolation` input field, worktree lifecycle in `run()`, `getCwd` dep |
| `packages/tools/src/agent-tool.test.ts` | Tests for isolation: worktree path |
| `packages/tools/src/index.ts` | Re-export worktree utilities |
| `packages/core/src/tool.ts` | No change (ToolContext.cwd already supports arbitrary paths) |
| `packages/core/src/agent.ts` | No change (runAgent already accepts cwd as param) |

## 10. Design Decisions

### D1: Worktree location under `.zuse/worktrees/` (not system temp dir)

CC uses `.claude/worktrees/`. We use `.zuse/worktrees/` under the repo root for
the same reasons: the worktree must be a sibling of the repo for git's internal
linking to work efficiently, and keeping it under the project's metadata directory
makes cleanup discoverable. System temp dirs risk cross-filesystem issues on
Linux (different mount points break git worktree hard-links).

### D2: No snapshot store for worktree sub-agents

Worktree sub-agents are capped at 10 turns and their entire working tree is
ephemeral. The snapshot store's `git add -A` per turn would add latency for
negligible value. If the sub-agent fails, the whole worktree is discarded.
The parent session's checkpoints cover the main repo; worktree changes are only
integrated via explicit merge.

### D3: Slugs use agent ID prefix, not description

`agent-<8hex>` is safe for branch names and filesystem paths across all platforms.
User descriptions may contain spaces, unicode, or special characters. CC uses the
same pattern (`agent-a<7hex>`).

### D4: Cleanup on success with no changes (auto-remove)

If the sub-agent finishes without modifying anything, the worktree and branch are
garbage. Keeping them wastes disk and pollutes `git branch -a`. Auto-cleanup
matches CC behavior and keeps the common case (read-only exploration agents) clean.

### D5: Report worktree path + branch rather than auto-merge

Auto-merging is dangerous: the parent agent hasn't reviewed the changes, merge
conflicts are possible, and the user may want to inspect before integrating.
Reporting the branch and path lets the parent agent (or user) decide: merge,
cherry-pick, or discard. CC follows the same "report, don't merge" pattern.

### D6: Windows compatibility

`git worktree` works on Windows. The main risk is symlink creation (CC symlinks
`node_modules` into worktrees to save disk). On Windows, symlinks require either
admin privileges or Developer Mode. For v1, we skip symlink optimization entirely.
The worktree gets a full checkout. `node_modules` can be addressed later via
settings-driven symlink configuration (matching CC's `worktree.symlinkDirectories`).

## 11. Future Extensions

- **`isolation: 'remote'`**: Launch the sub-agent in a cloud sandbox. Requires a
  different backend but the same interface contract (create, run, report/cleanup).
- **Merge assistance**: A `MergeWorktree` tool that the parent agent can invoke to
  merge a worktree branch back into the main branch, handling conflicts.
- **Parallel write workflows**: The Workflow system (Phase 15.2) can default to
  `isolation: 'worktree'` for all write-capable sub-agents, eliminating the need
  for the model to opt in per invocation.
- **Symlink optimization**: Settings-driven directory symlinks (e.g., `node_modules`)
  to reduce worktree disk footprint, gated behind Windows admin check.
- **Sparse checkout**: For large monorepos, `git sparse-checkout set --cone` with
  configurable paths (matching CC's `worktree.sparsePaths` setting) to speed up
  worktree creation.
