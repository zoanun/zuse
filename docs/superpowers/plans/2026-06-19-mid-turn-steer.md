# Mid-Turn STEER Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the user to send a message while the model is executing tools, injecting it into the next tool_result so the model can adjust course without losing progress.

**Architecture:** Three layers — (1) agent.ts adds `consumeSteer` callback to RunAgentOptions and injects steer text after the last tool result in each batch, (2) useConversation.ts manages a steerQueue ref and provides the callback, (3) App.tsx/InputBox.tsx routes input to steer queue when model is thinking instead of disabling the input box.

**Tech Stack:** TypeScript, React (Ink), Vitest

---

### Task 1: Add consumeSteer to agent loop

**Files:**
- Modify: `packages/core/src/agent.ts:56-88` (RunAgentOptions) and `~252-270` (tool result staging)

- [ ] **Step 1: Write failing test**

Add to `packages/core/src/agent.test.ts`:

```ts
  it('injects steer text into the last tool result', async () => {
    const toolScript: StreamEvent[] = [
      { type: 'tool-use', id: 'a', name: 'echo', input: { value: 'hi' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]
    const doneScript: StreamEvent[] = [
      { type: 'text-delta', text: 'ok' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
    ]
    const { client } = fakeClient([toolScript, doneScript])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    reg.register(echoTool())

    let steerConsumed = false
    const events = await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'go',
        config,
        cwd: '.',
        signal,
        consumeSteer: () => {
          if (!steerConsumed) {
            steerConsumed = true
            return 'skip test files'
          }
          return null
        },
      }),
    )

    const toolResult = events.find((e) => e.type === 'tool-result' && e.name === 'echo')
    expect(toolResult).toBeTruthy()
    if (toolResult && toolResult.type === 'tool-result') {
      expect(toolResult.output).toContain('[USER MESSAGE')
      expect(toolResult.output).toContain('skip test files')
    }
  })

  it('does not inject when consumeSteer returns null', async () => {
    const toolScript: StreamEvent[] = [
      { type: 'tool-use', id: 'a', name: 'echo', input: { value: 'hi' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]
    const doneScript: StreamEvent[] = [
      { type: 'text-delta', text: 'ok' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
    ]
    const { client } = fakeClient([toolScript, doneScript])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    reg.register(echoTool())

    const events = await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'go',
        config,
        cwd: '.',
        signal,
        consumeSteer: () => null,
      }),
    )

    const toolResult = events.find((e) => e.type === 'tool-result' && e.name === 'echo')
    expect(toolResult).toBeTruthy()
    if (toolResult && toolResult.type === 'tool-result') {
      expect(toolResult.output).not.toContain('[USER MESSAGE')
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/agent.test.ts -t "injects steer"`
Expected: FAIL — `consumeSteer` is not a recognized option.

- [ ] **Step 3: Implement consumeSteer in agent.ts**

Add to `RunAgentOptions` interface (after `onCwdChange`):

```ts
  /**
   * Mid-turn steering: called after each tool batch completes. Returns the user's
   * queued steer text (concatenated if multiple), or null if nothing queued.
   * The text is appended to the last tool result before feeding back to the model.
   */
  consumeSteer?: () => string | null
```

Then in the tool result staging section (after the `for` loop that builds `resultBlocks`, around line 270), add steer injection:

```ts
    // Mid-turn steer: if the user sent a message while tools were running,
    // append it to the last tool result so the model sees it on the next turn.
    const steer = opts.consumeSteer?.()
    if (steer && resultBlocks.length > 0) {
      const injection = `\n\n[USER MESSAGE — sent while you were working]\n${steer}\n[/USER MESSAGE]\nIMPORTANT: Address the user's message above. It takes priority over your current task. You may continue your current work after acknowledging it, or change direction if they asked you to.`
      const last = resultBlocks[resultBlocks.length - 1]!
      if (last.type === 'tool_result') {
        last.content += injection
      }
    }
```

Note: this modifies `resultBlocks` which is already built but not yet staged. The `yield` events (for UI display) have already been emitted without the steer text — that's correct; the steer appears in the model's context but not in the UI tool result display.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/agent.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "feat(agent): add consumeSteer for mid-turn user message injection"
```

---

### Task 2: Add steer queue to useConversation

**Files:**
- Modify: `packages/tui/src/hooks/useConversation.ts`

- [ ] **Step 1: Add steerQueue ref and consumeSteer callback**

In the ref declarations section (around line 186, near `ineffectiveCompactionRef`), add:

```ts
  // Mid-turn steer queue: user messages sent while the model is working.
  // Drained by consumeSteer callback after each tool batch.
  const steerQueueRef = useRef<string[]>([])
```

- [ ] **Step 2: Add a `steer` method to the returned interface**

In the `UseConversationReturn` interface (around line 97), add:

```ts
  /** Queue a mid-turn steer message (sent while model is working). */
  steer: (text: string) => void
```

- [ ] **Step 3: Implement the steer method**

After the `sendMessage` callback definition (around line 770), add:

```ts
  const steer = useCallback((text: string) => {
    if (text.trim() === '') return
    steerQueueRef.current.push(text.trim())
    // Show the steer as a subtle system bubble so user sees it was received
    setState((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        { id: generateId(), role: 'system', text: `⚡ ${text.trim()}`, isStreaming: false },
      ],
    }))
  }, [])
```

- [ ] **Step 4: Wire consumeSteer into the runAgent call**

In the `sendMessage` callback, find the `runAgent({...})` call (around line 538). Add `consumeSteer` to the options:

```ts
      try {
        for await (const event of runAgent({
          conversation,
          client: clientRef.current,
          registry,
          userText: `[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ${text}`,
          config: { ... },
          cwd: cwdRef.current,
          signal: controller.signal,
          tracker: trackerRef.current,
          settings,
          sessionAllow: sessionAllowRef.current,
          canUseTool,
          onPersistAllow,
          onCwdChange: (p) => { cwdRef.current = p },
          consumeSteer: () => {
            const queue = steerQueueRef.current
            if (queue.length === 0) return null
            const combined = queue.join('\n')
            queue.length = 0
            return combined
          },
        })) {
```

- [ ] **Step 5: Export steer in the return object**

Find the return object of `useConversation` (around line 960-1000) and add `steer`:

```ts
    return {
      state: { ... },
      submit,
      clear,
      steer,    // ← add this
      ...
    }
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/tui/src/hooks/useConversation.ts
git commit -m "feat(tui): add steer queue for mid-turn user messages"
```

---

### Task 3: Route input to steer queue during execution

**Files:**
- Modify: `packages/tui/src/App.tsx`
- Modify: `packages/tui/src/components/InputBox.tsx`

- [ ] **Step 1: Change InputBox to accept steer mode**

In `packages/tui/src/components/InputBox.tsx`, change the `InputBoxProps` interface:

```ts
interface InputBoxProps {
  onSubmit: (text: string, displayText?: string, pasteFiles?: Record<number, string>) => void
  isDisabled: boolean
  /** When true, input is in steer mode — submissions go through onSteer instead of onSubmit. */
  isSteerMode?: boolean
  /** Called when user submits in steer mode. */
  onSteer?: (text: string) => void
  commands: CommandInfo[]
}
```

Update the function signature:

```ts
export function InputBox({ onSubmit, isDisabled, isSteerMode, onSteer, commands }: InputBoxProps) {
```

In steer mode, the input box should:
- NOT be disabled (user can type)
- Use a different prompt prefix (e.g., `⚡` instead of `›`)
- NOT show the command menu (no slash commands in steer mode)
- On submit, call `onSteer(text)` instead of `onSubmit(text)`, then clear the input

Find the `handleSubmit` function inside InputBox (the internal one that calls `onSubmit`). Wrap it:

```ts
  const handleSubmit = (): void => {
    const text = model.buf.text.trim()
    if (text === '') return
    if (isSteerMode && onSteer) {
      onSteer(text)
      setModel({ buf: emptyBuffer, pastes: new Map(), nextId: 0 })
      return
    }
    // ... existing submit logic ...
  }
```

Find where the prompt prefix `›` is rendered and change it:

```ts
const prefix = isSteerMode ? '⚡' : '›'
```

- [ ] **Step 2: Wire steer mode in App.tsx**

In `packages/tui/src/App.tsx`, the `useConversation` destructuring needs `steer`:

```ts
  const {
    state,
    submit,
    steer,    // ← add this
    ...
  } = useConversation({ ... })
```

Change the InputBox rendering (around line 243):

```ts
        <InputBox
          onSubmit={handleSubmit}
          isDisabled={false}
          isSteerMode={state.isThinking}
          onSteer={steer}
          commands={commands}
        />
```

Key change: `isDisabled` is now always `false`. When `state.isThinking` is true, InputBox enters steer mode instead of being disabled.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS. If InputBox tests check `isDisabled` behavior, update them to account for steer mode.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/App.tsx packages/tui/src/components/InputBox.tsx
git commit -m "feat(tui): enable steer mode input during model execution"
```
