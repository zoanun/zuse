# S1 — Multi-Session Persistence + List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox (`- [ ]`) tracking.

**Goal:** Multiple JSON-file-persisted web sessions with HTTP REST CRUD + WS attach-by-sessionId + restore-on-attach + autosave; minimal frontend wiring (connect with a remembered session id, New chat creates a session). Full session-list sidebar = S2.

**Spec:** `docs/superpowers/specs/2026-06-26-S1-multi-session-persistence-design.md` (READ — full types + flows + decisions).

**Branch:** `feature/s1-multi-session` (off `master`).

**Tests:** server via repo-root `npx vitest run packages/server`; web via `pnpm -F @zuse/web test`. Typecheck: `cd packages/server && npx tsc --noEmit` / `pnpm -F @zuse/web typecheck`. Server package name is `@zouyj/zuse-server`. PROJECT RULE: verify real shapes from source; no `@zuse/tui` import in server/web; deterministic tests in TEMP dirs (never real `~/.zuse`).

---

## Task 1: Session store (JSON persistence)

**Files:** Create `packages/server/src/session/sessionStore.ts` + `sessionStore.test.ts`.

- [ ] READ `packages/tui/src/commands/sessionStore.ts` (format reference — do NOT import it) and `packages/core/src/conversation.ts` (`toJSON`/`fromJSON`, `ConversationSnapshot`), and `packages/server/src/session/events.ts` (`SessionCheckpoint`).
- [ ] Define server-local `SessionRecord` (per spec §2: version:1, id, title, cwd, model?, createdAt, updatedAt, messages, totalUsage, checkpoints) and `SessionMeta` (`{id,title,createdAt,updatedAt,cwd,messageCount}`). Import `Message`/`Usage` from `@zuse/core`, `SessionCheckpoint` from `./events.js`.
- [ ] Implement (all take an explicit `dir: string` base so tests use a temp dir):
  - `newSessionId(now?): string` — mirror TUI (timestamp + 4 random hex). `new Date()`/`Math.random()` are fine (server runtime).
  - `saveSession(dir, rec): Promise<void>` — atomic write (write tmp then rename) to `<dir>/<id>.json`, `mkdir -p dir`.
  - `loadSession(dir, id): Promise<SessionRecord | null>` — read+parse; return null on missing/parse error.
  - `listSessions(dir): Promise<SessionMeta[]>` — read dir, parse each, map to meta (messageCount = messages.length), skip bad files, sort by updatedAt desc.
  - `deleteSession(dir, id): Promise<void>` — unlink, ignore missing.
- [ ] Tests (temp dir via `mkdtempSync`): save→load round-trip (all fields incl. checkpoints); list returns sorted metas + skips a corrupt file; delete removes; newSessionId shape (`/^\d{8}-\d{6}-[0-9a-z]{4}$/` or whatever you implement — assert your own format).
- [ ] `npx vitest run packages/server/src/session/sessionStore` + server typecheck. Commit: `feat(server): JSON session store (save/load/list/delete)`

---

## Task 2: SessionManager accessors + checkpoints restore

**Files:** `packages/server/src/session/SessionManager.ts` (+ test).

- [ ] Add to `SessionManagerOptions`: `checkpoints?: SessionCheckpoint[]`. In constructor: `this.checkpoints = opts.checkpoints ?? []` (currently inits `[]`).
- [ ] Add public accessors: `getConversation(): Conversation` (return `this.conversation`), `getCheckpoints(): SessionCheckpoint[]` (return a copy `[...this.checkpoints]`), `getCreatedAt(): string`, `getModelId(): string` (`this.client.getModel()`). (These let the store serialize a live session.)
- [ ] Test: construct with `conversation: Conversation.fromJSON(...)` + `checkpoints: [cp]` → `getConversation().getMessages()` matches, `getCheckpoints()` returns the cp, `getState()` reflects restored messageCount/checkpoints. Use existing test fakes.
- [ ] `npx vitest run packages/server/src/session/SessionManager` + typecheck. Commit: `feat(server): SessionManager conversation/checkpoints accessors + restore opt`

---

## Task 3: createSession takes sessionId + restore opts; update startServer

**Files:** `packages/server/src/session/createSession.ts` (+ test), `packages/server/src/startServer.ts`, `packages/server/src/config.ts`.

- [ ] READ current `createSession(cwd, deps?)` + `startServer.ts` single-session creation + `config.ts` DEFAULT_SESSION_ID.
- [ ] Change `createSession` signature to `createSession(opts: { sessionId: string; cwd: string; conversation?: Conversation; checkpoints?: SessionCheckpoint[]; createdAt?: string; client?: ModelClient; snapshotStore?: SnapshotStore }): SessionManager`. Use `opts.sessionId` (not DEFAULT_SESSION_ID) for the SessionManager; pass through conversation/checkpoints/createdAt. Keep all other assembly identical.
- [ ] Update `startServer.ts`: the startup `createSession(cfg.cwd)` call → for S1 the SessionService (Task 4) owns session creation, so startServer should NOT pre-create DEFAULT anymore (or keep a fallback — see Task 4). Adjust to construct the `SessionService` and pass it to `attachWsServer` + the REST handler. (Coordinate with Task 4; you may implement Task 4's service first if cleaner — keep commits green.)
- [ ] Update existing tests that call `createSession(cwd)` to the new options shape.
- [ ] `npx vitest run packages/server` + typecheck. Commit: `refactor(server): createSession takes sessionId + restore opts`

> NOTE: Tasks 3 & 4 are coupled (startServer wiring depends on SessionService). The implementer may merge them into one commit if cleaner; keep the suite green.

---

## Task 4: SessionService (lifecycle: getOrLoad/create/list/delete + autosave)

**Files:** Create `packages/server/src/session/SessionService.ts` (+ test). Modify `startServer.ts` to instantiate it.

- [ ] Implement `SessionService` wrapping a `SessionRegistry` + the store dir (per spec §5):
  - constructor `(opts: { dir: string; cwd: string; createSession?: typeof createSession })` — `createSession` injectable for tests.
  - `getOrLoad(id): Promise<SessionManager | null>` — registry hit → return; else `loadSession(dir,id)` → if found, `createSession({sessionId:id, cwd: rec.cwd, conversation: Conversation.fromJSON({version:1,messages:rec.messages,totalUsage:rec.totalUsage}), checkpoints: rec.checkpoints, createdAt: rec.createdAt})` → register → wire autosave → return; else null.
  - `create(opts?: {cwd?; title?}): Promise<{id:string}>` — newSessionId → createSession({sessionId, cwd: opts?.cwd ?? this.cwd}) → register → wire autosave → save an initial record → return id.
  - `list(): Promise<SessionMeta[]>` — `listSessions(dir)` merged with any in-memory sessions not yet on disk; dedupe by id; sort updatedAt desc.
  - `delete(id): Promise<void>` — registry.remove + deleteSession(dir,id).
  - **autosave wiring** (`private autosave(id, mgr)`): `mgr.subscribe(e => { if (e.type==='turn-end' || e.type==='checkpoint-recorded') void this.persist(id, mgr) })`; also persist after a `reset` if applicable. `persist(id, mgr)` builds a SessionRecord from `mgr.getConversation().toJSON()` + `mgr.getCheckpoints()` + title (derive from first user message text, ≤60 chars, else 'New chat') + `mgr.getModelId()` + cwd + createdAt + updatedAt=now, then `saveSession`. Fire-and-forget, swallow errors.
- [ ] `startServer.ts`: instantiate `new SessionService({ dir: <web-sessions dir under authDir or cwd>, cwd: cfg.cwd })`; pass to `attachWsServer` and the REST routes (Task 5). Decide the sessions dir (e.g. `join(cfg.authDir, 'web-sessions')` — confirm `authDir` is on ServerConfig). Remove the old single DEFAULT pre-creation (or keep a lazy default — but spec says clients must pass an id; startServer no longer needs to pre-create).
- [ ] Tests (temp dir, injected fake-client createSession): create→list shows it; getOrLoad hits memory then (after dropping from registry) loads from disk; delete removes from list; autosave writes a record after a scripted turn-end (drive a turn via the fake client, assert file appears/updates).
- [ ] `npx vitest run packages/server` + typecheck. Commit: `feat(server): SessionService — lifecycle + autosave`

---

## Task 5: HTTP REST /api/sessions

**Files:** `packages/server/src/http/server.ts` (+ test).

- [ ] READ how `makeRequestHandler` dispatches routes + how `SessionService` is passed in (add it to the handler deps). Add auth-gated routes (per spec §6):
  - `GET /api/sessions` → `sendJson(200, await service.list())`.
  - `POST /api/sessions` → read JSON body `{cwd?, title?}` (tolerate empty) → `await service.create(body)` → `sendJson(200, {id})`.
  - `DELETE /api/sessions/<id>` → extract id from path → `await service.delete(id)` → `sendJson(200, {ok:true})`.
  - All require auth (reuse the existing auth check used by `/api/auth/logout`); unauth → 401.
- [ ] Path matching: extend the if-chain — match `/api/sessions` exactly for GET/POST, and `/api/sessions/<id>` (startsWith + slice) for DELETE.
- [ ] Tests (integration, port 0, temp web-sessions dir, auth cookie): login → POST creates (returns id) → GET lists it → DELETE → GET no longer lists it; unauthenticated GET → 401.
- [ ] `npx vitest run packages/server` + typecheck. Commit: `feat(server): REST /api/sessions CRUD (§5.1 resource API)`

---

## Task 6: WS attach by sessionId

**Files:** `packages/server/src/ws/wsServer.ts` (+ test).

- [ ] READ current attach (hardcoded `registry.get(DEFAULT_SESSION_ID)`). Change `attachWsServer` deps to take the `SessionService` (instead of/in addition to registry). On upgrade (after cookie auth): parse `?session=<id>` from the request URL; `const mgr = await service.getOrLoad(id)`; if no id or null → send an error frame and close (per spec §7: clients must pass a valid id — they create one via REST first). On success: send snapshot (already messages+checkpoints from M6) + subscribe (unchanged).
- [ ] Tests (port 0, temp dir, injected fake client): create a session via service/REST, connect WS `?session=<id>` → receives snapshot for that session; two connections same id share the manager (both get an event from one turn); connecting with a bogus id → error frame / closed; (regression) the existing wsServer tests updated to pass a `?session=<id>` for a created session.
- [ ] `npx vitest run packages/server` (all green) + typecheck. Commit: `feat(server): WS attach by ?session=<id> via SessionService`

---

## Task 7: Web minimal wiring (connect-with-id + New chat creates session)

**Files:** `packages/web/src/ws/client.ts` (connect URL), `packages/web/src/state/store.tsx` / wherever the WS URL + New-chat handler live, `Sidebar.tsx` (New chat button) (+ tests).

- [ ] READ the web WS client connect (how the `/ws` URL is built), the store, and the current "New chat" handler (sends `reset-session`).
- [ ] On startup: read `localStorage['zuse.sessionId']`; if absent → `POST /api/sessions` (fetch, credentials same-origin) → store the returned id. Connect WS with `?session=<id>`.
- [ ] "New chat": `POST /api/sessions` → store new id in localStorage → reconnect WS to the new id (and clear local message state via the existing `reset` action). Replace the `reset-session` send (keep backend reset() for now, but the button now creates a session).
- [ ] Tests (jsdom, mock fetch + ws): startup with no stored id POSTs then connects with the returned id; New chat POSTs + reconnects to the new id. Mock localStorage. Keep existing web tests green (the connect URL now has `?session=`).
- [ ] `pnpm -F @zuse/web test` (all green) + `pnpm -F @zuse/web typecheck`. Commit: `feat(web): connect with persisted session id; New chat creates a session`

---

## Task 8: Verification + smoke

- [ ] `npx vitest run packages/server` + `pnpm -F @zuse/web test` all green; both typechecks clean; `pnpm -r typecheck` (note pre-existing unrelated failures e.g. workflow.test.ts — not S1).
- [ ] grep `packages/server/src` + `packages/web/src` for `@zuse/tui` → zero.
- [ ] Manual smoke (controller runs): build web, run `npx tsx packages/server/src/bin.ts`, browser → send a few messages → refresh (history persists) → New chat (fresh session, old one still on disk) → `curl localhost:4180/api/sessions` (with cookie) lists sessions → restart daemon → reconnect with same id → history restored.
- [ ] Controller merges branch into master after final review.

---

## Self-review notes (verify at implementation)
1. `Conversation.toJSON()` shape (`{version:1,messages,totalUsage}`) for the record; `fromJSON` for restore.
2. `ServerConfig` fields — where to root the web-sessions dir (`authDir`? add a field?).
3. SessionManager checkpoints are currently fully private — Task 2 adds the accessor + restore opt before Task 4 uses them.
4. Tasks 3+4 are coupled (startServer wiring) — keep each commit's suite green; may combine.
5. The old `reset-session` / DEFAULT_SESSION_ID path: don't break existing tests — update them to the multi-session model (create-then-attach).
6. No real `~/.zuse` writes in tests — always temp dirs.
