# M6 — Checkpoint Timeline + Revert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Web UI lists per-turn checkpoints and one-click reverts; revert re-syncs the UI (and reconnect shows history) by enriching the snapshot with messages + checkpoints.

**Spec:** `docs/superpowers/specs/2026-06-26-M6-checkpoint-timeline-design.md` (READ it — has full type defs + flow).

**Branch:** `feature/m6-checkpoint-timeline` (off `f4-react-frontend`).

**Tests:** server via repo-root `npx vitest run packages/server`; web via `pnpm -F @zuse/web test`. Typecheck `pnpm -F @zuse/server typecheck` / `pnpm -F @zuse/web typecheck`. Verify all real shapes from source (project rule).

---

## Task 1: Protocol additions (`@zuse/protocol`)

**File:** `packages/protocol/src/index.ts`.

- [ ] Add types per spec §2: `SnapshotPart`, `SnapshotMessage`, `CheckpointLite`; `ClientMessage += {type:'revert';checkpointId:string}`; `SessionEvent += {type:'reverted';checkpointId:string}`; `SessionSnapshot += messages: SnapshotMessage[]` and `checkpoints: CheckpointLite[]`.
- [ ] `pnpm -F @zuse/protocol typecheck` (or build) clean. Protocol is type-only — no runtime.
- [ ] This will break `@zuse/server` + `@zuse/web` typecheck (snapshot/event now require new fields / new union members unhandled) — that's expected; later tasks fix each consumer. Commit protocol alone:
  `git commit -m "feat(protocol): revert message, reverted event, snapshot messages+checkpoints"`

> NOTE: after this, server's `getState()`/snapshot construction and web's reducer won't compile until Tasks 2 & 4. Do tasks in order; keep each commit's OWN package green even if cross-package typecheck lags until Task 4. (If the monorepo typecheck is all-or-nothing, it's fine for intermediate commits to have known cross-package gaps closed by Task 4 — note it in each task's report.)

---

## Task 2: Server — message projection + enriched snapshot

**Files:** `packages/server/src/session/SessionManager.ts` (+ its test).

- [ ] Read core's `Conversation.getMessages()` return + `ContentBlock` union (`packages/core/src/conversation.ts` / `types.ts`) to know the real shape of text / tool_use / tool_result blocks (field names: `tool_use` → id/name/input; `tool_result` → tool_use_id/content/is_error — VERIFY).
- [ ] Add `private projectMessages(): SnapshotMessage[]` — map each conversation message (role user/assistant) → `{role, parts}` where content blocks map to `SnapshotPart` (text→text; tool_use→tool-use{id,name,input}; tool_result→tool-result{id,name,output,isError}). For `tool_result` blocks that lack a tool name, derive from the paired tool_use id if cheap, else use `''`; flatten `content` to a string for `output`. Skip/[]-out unrenderable blocks.
- [ ] Extend the snapshot builder (the method wsServer calls — find it, likely `getState()` returning `SessionSnapshot`) to include `messages: this.projectMessages()` and `checkpoints: this.checkpoints.map(c => ({ id: c.hash, label: c.label }))`. (Confirm `SessionCheckpoint` has `hash` + `label`.)
- [ ] Test: build a SessionManager with a seeded `Conversation` (user text + assistant text + a tool_use/tool_result pair) → assert snapshot `.messages` projects correctly and `.checkpoints` reflects recorded checkpoints.
- [ ] `npx vitest run packages/server/src/session/SessionManager` + server typecheck (server should compile now that snapshot has the new fields).
- [ ] Commit: `feat(server): project conversation into snapshot messages + checkpoints`

---

## Task 3: Server — revert emits `reverted`; wire revert up-message + snapshot re-push

**Files:** `SessionManager.ts`, `ws/clientMessage.ts`, `ws/wsServer.ts` (+ their tests).

- [ ] `SessionManager.revert(checkpointId)`: at the end (after existing truncate/restore/drop-checkpoints/clear-contextTokens), `this.emit({ type:'reverted', checkpointId })`.
- [ ] `clientMessage.ts`: handle `{type:'revert', checkpointId}` → `mgr.revert(checkpointId)`. (Unknown id → mgr no-op; safe.) Read the existing dispatch to match its style.
- [ ] `wsServer.ts`: in the per-connection event listener, when `event.type === 'reverted'`, after/instead of forwarding it, ALSO send a fresh `{type:'snapshot', snapshot: mgr.getSnapshot()}` frame to that connection (so every attached client re-syncs to post-revert state). Still forward the `reverted` event too (for the notice). Read how snapshot frames are currently sent on attach to reuse the same encode path.
- [ ] Tests: (a) `revert()` emits `reverted` (script a turn that records a checkpoint, then revert, assert event + conversation truncated); (b) `clientMessage` routes `revert` → mgr.revert; (c) wsServer integration (port 0, injected fake client, scripted turn → checkpoint): send `{type:'revert',checkpointId}` up → connection receives a `reverted` event AND a fresh `snapshot` frame whose `messages` reflect truncation.
- [ ] `npx vitest run packages/server` (all green) + typecheck.
- [ ] Commit: `feat(server): revert via WS — emit reverted + re-push snapshot to resync clients`

---

## Task 4: Web — reducer + state for checkpoints & snapshot-rebuilt messages

**Files:** `packages/web/src/state/types.ts`, `state/reducer.ts` (+ `reducer.test.ts`).

- [ ] `types.ts`: `AppState += checkpoints: CheckpointLite[]` (import from `@zuse/protocol`); `initialState.checkpoints = []`.
- [ ] `reducer.ts`:
  - `applySnapshot`: map `snapshot.messages` (SnapshotMessage[]) → UI `Message[]` (generate stable ids like `h${i}`; map SnapshotPart→Part: text/tool-use/tool-result, `isError`→`isError`) and set `state.messages` to it; set `state.checkpoints = snapshot.checkpoints`. (This replaces the message list — correct for attach & post-revert resync.)
  - Add `case 'checkpoint-recorded'`: `{ ...state, checkpoints: [...state.checkpoints, { id: e.id, label: e.label }] }`.
  - Add `case 'reverted'`: `withNotice(state, 'reverted to checkpoint', 'info')` (messages rebuilt by the snapshot frame that follows).
- [ ] Tests (`reducer.test.ts`): applySnapshot with messages+checkpoints rebuilds `messages` and sets `checkpoints`; `checkpoint-recorded` appends; `reverted` adds a notice.
- [ ] `pnpm -F @zuse/web test` (reducer) + `pnpm -F @zuse/web typecheck`.
- [ ] Commit: `feat(web): reducer rebuilds messages from snapshot + tracks checkpoints`

---

## Task 5: Web — revert dispatch + CheckpointTimeline UI

**Files:** `packages/web/src/state/store.tsx` (or wherever WS send/dispatch lives), new `packages/web/src/components/CheckpointTimeline.tsx` (+ test), and mount it (Sidebar or Header drawer).

- [ ] Read `store.tsx` to see how existing client messages are sent (e.g. how Composer sends `send`, PermissionCard sends `permission-reply`). Add a `revert(checkpointId)` action/helper that sends `{type:'revert', checkpointId}` over the same WS channel.
- [ ] `CheckpointTimeline.tsx`: render `state.checkpoints` (label, in order). Each row a "revert" button with a confirm (e.g. window.confirm or an inline confirm state). Click → `revert(id)`. Empty state: "no checkpoints yet". Disable buttons while `state.thinking` (revert mid-turn is odd) — minor.
- [ ] Mount it in the existing Sidebar (`Sidebar.tsx`) or a header drawer — pick where the sidebar currently lives; keep styling consistent with existing components.
- [ ] Test (`CheckpointTimeline.test.tsx`, @testing-library/react): renders checkpoints; clicking revert (past confirm) calls the store's revert with the right id / sends the right WS message (mock the send).
- [ ] `pnpm -F @zuse/web test` (all green) + `pnpm -F @zuse/web typecheck`.
- [ ] Commit: `feat(web): checkpoint timeline UI with one-click revert`

---

## Task 6: Full verification + manual smoke

- [ ] `npx vitest run packages/server` + `pnpm -F @zuse/web test` (all green); `pnpm -F @zuse/server typecheck` + `pnpm -F @zuse/web typecheck` clean; `pnpm -r typecheck` (note any PRE-EXISTING unrelated failures e.g. workflow.test.ts — not M6).
- [ ] grep `packages/server/src` for `@zuse/tui` → zero (decoupling).
- [ ] Manual smoke (report to controller; controller runs the app): build web (`pnpm -C packages/web build`), run `npx tsx packages/server/src/bin.ts`, browser → run 2 turns (one touching a file so a checkpoint is meaningful) → timeline shows checkpoints → revert one (confirm) → conversation truncates + files roll back + later checkpoints vanish → refresh page → history + timeline still present.
- [ ] (Controller merges the branch into `f4-react-frontend` after review.)

---

## Self-review notes (verify at implementation)
1. Real `ContentBlock` shapes for the projection (tool_result field names — `tool_use_id`, `content`, `is_error`).
2. The snapshot-builder method name on SessionManager (`getState` vs `getSnapshot`) — extend the one wsServer uses on attach.
3. `SessionCheckpoint` fields (`hash`/`label`/`messageIndex`).
4. Each intermediate commit: keep that package's own tests/typecheck green; cross-package typecheck closes by Task 4/5.
5. No `@zuse/tui` import in server/web.
