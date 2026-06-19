# Model-Tiered Prompt Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject XML-structured enforcement prompts for non-Claude models to reduce "say-but-don't-do", fabrication, and premature completion failure modes.

**Architecture:** Add optional `modelId` param to `buildSystemPrompt`, detect Claude via substring match, conditionally append enforcement overlay between env block and user sections. Separately strengthen the maxTurns stop text in `agent.ts`.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Add enforcement overlay and model detection to prompt.ts

**Files:**
- Modify: `packages/core/src/prompt.ts:11-68`

- [ ] **Step 1: Write failing tests for overlay injection**

Add these tests to `packages/core/src/prompt.test.ts`:

```ts
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, NON_CLAUDE_ENFORCEMENT_OVERLAY, isClaudeFamily, type AgentEnvironment } from './prompt.js'

// ... existing ENV and tests ...

describe('isClaudeFamily', () => {
  it('returns true for claude model ids', () => {
    expect(isClaudeFamily('claude-sonnet-4-6')).toBe(true)
    expect(isClaudeFamily('claude-opus-4-8')).toBe(true)
    expect(isClaudeFamily('claude-haiku-4-5-20251001')).toBe(true)
  })

  it('returns true for anthropic-prefixed ids', () => {
    expect(isClaudeFamily('anthropic/claude-sonnet')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isClaudeFamily('Claude-Sonnet-4-6')).toBe(true)
    expect(isClaudeFamily('CLAUDE-OPUS')).toBe(true)
  })

  it('returns false for non-claude models', () => {
    expect(isClaudeFamily('deepseek-v4')).toBe(false)
    expect(isClaudeFamily('gpt-4o-mini')).toBe(false)
    expect(isClaudeFamily('qwen-2.5')).toBe(false)
    expect(isClaudeFamily('gemini-2.5-flash')).toBe(false)
    expect(isClaudeFamily('glm-5.1')).toBe(false)
    expect(isClaudeFamily('unknown')).toBe(false)
  })
})

describe('model-tiered overlay', () => {
  it('injects enforcement overlay for non-Claude models', () => {
    const prompt = buildSystemPrompt(ENV, [], 'deepseek-v4')
    expect(prompt).toContain('<tool_use_enforcement>')
    expect(prompt).toContain('<anti_fabrication>')
    expect(prompt).toContain('<mandatory_tool_use>')
    expect(prompt).toContain('<completion_contract>')
  })

  it('does NOT inject overlay for Claude models', () => {
    const prompt = buildSystemPrompt(ENV, [], 'claude-sonnet-4-6')
    expect(prompt).not.toContain('<tool_use_enforcement>')
  })

  it('does NOT inject overlay when modelId is omitted', () => {
    const prompt = buildSystemPrompt(ENV)
    expect(prompt).not.toContain('<tool_use_enforcement>')
  })

  it('places overlay after env block but before sections', () => {
    const prompt = buildSystemPrompt(
      ENV,
      [{ title: 'User instructions', content: 'Be brief.' }],
      'gpt-4o-mini',
    )
    const envIdx = prompt.indexOf('Environment:')
    const overlayIdx = prompt.indexOf('<tool_use_enforcement>')
    const sectionIdx = prompt.indexOf('## User instructions')
    expect(envIdx).toBeLessThan(overlayIdx)
    expect(overlayIdx).toBeLessThan(sectionIdx)
  })

  it('output is byte-identical to no-modelId when modelId is claude', () => {
    const withoutId = buildSystemPrompt(ENV, [])
    const withClaudeId = buildSystemPrompt(ENV, [], 'claude-sonnet-4-6')
    expect(withClaudeId).toBe(withoutId)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run src/prompt.test.ts`
Expected: FAIL — `isClaudeFamily` and `NON_CLAUDE_ENFORCEMENT_OVERLAY` not exported, `buildSystemPrompt` doesn't accept 3rd arg.

- [ ] **Step 3: Implement isClaudeFamily, overlay constant, and injection logic**

Edit `packages/core/src/prompt.ts`. Add after the `DEFAULT_SYSTEM_PROMPT` constant (after line 29):

```ts
/**
 * 非 Claude 模型的强制执行约束。用 XML 标签结构化——弱模型对 XML 边界的
 * 识别优于纯散文段落（Hermes / OpenClaw 实战验证）。
 *
 * 四个块分别针对弱模型的四类高频失败模式：
 *   1. tool_use_enforcement — 光说不做
 *   2. mandatory_tool_use   — 凭记忆回答事实问题
 *   3. anti_fabrication     — 编造输出
 *   4. completion_contract  — 半成品交付
 */
export const NON_CLAUDE_ENFORCEMENT_OVERLAY = `
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
</completion_contract>`

/** Claude 系模型不需要额外约束——原有提示词已足够。 */
export function isClaudeFamily(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return id.includes('claude') || id.includes('anthropic')
}
```

Then modify `buildSystemPrompt` to accept `modelId` and inject the overlay:

```ts
export function buildSystemPrompt(
  env: AgentEnvironment,
  sections: Array<{ title: string; content: string }> = [],
  modelId?: string,
): string {
  const block = [
    'Environment:',
    `- Operating system: ${env.platform}${env.osVersion ? ` (${env.osVersion})` : ''}`,
    `- Shell: ${env.shell} — the Bash tool runs commands through this shell; use its command syntax.`,
    `- Working directory: ${env.cwd}`,
    `- Today's date: ${env.date}`,
  ].join('\n')
  const overlay = modelId && !isClaudeFamily(modelId) ? `\n${NON_CLAUDE_ENFORCEMENT_OVERLAY}` : ''
  const extras = sections.map((s) => `\n\n## ${s.title}\n${s.content}`).join('')
  return `${DEFAULT_SYSTEM_PROMPT}\n\n${block}${overlay}${extras}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/prompt.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/prompt.ts packages/core/src/prompt.test.ts
git commit -m "feat(prompt): add model-tiered enforcement overlay for non-Claude models"
```

---

### Task 2: Strengthen maxTurns stop text in agent.ts

**Files:**
- Modify: `packages/core/src/agent.ts:242-249`
- Modify: `packages/core/src/agent.test.ts:306-333`

- [ ] **Step 1: Write failing test for new maxTurns text**

Add to the existing `stops at maxTurns` test in `packages/core/src/agent.test.ts`, after line 332:

```ts
  it('maxTurns stop message uses forceful CRITICAL text', async () => {
    const loopScript: StreamEvent[] = [
      { type: 'tool-use', id: 'c', name: 'echo', input: { value: 'x' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]
    const { client } = fakeClient([loopScript, loopScript, loopScript])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    reg.register(echoTool())

    await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'go',
        config,
        cwd: '.',
        signal,
        maxTurns: 2,
      }),
    )
    const msgs = conv.getMessages()
    const lastMsg = msgs[msgs.length - 1]!
    const text = lastMsg.content[0]!
    expect(text).toHaveProperty('type', 'text')
    if (text.type === 'text') {
      expect(text.text).toContain('CRITICAL')
      expect(text.text).toContain('Do NOT attempt any more tool calls')
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/agent.test.ts -t "maxTurns stop message"`
Expected: FAIL — current text is `[Stopped: reached max turns (2).]`, doesn't contain `CRITICAL`.

- [ ] **Step 3: Implement MAX_TURNS_STOP_TEXT and replace usage**

In `packages/core/src/agent.ts`, add after the `DEFAULT_MAX_TURNS` constant (after line 13):

```ts
export const MAX_TURNS_STOP_TEXT = (n: number): string =>
  `[CRITICAL: Maximum tool turns (${n}) reached. Tools are now disabled. ` +
  `Do NOT attempt any more tool calls. Summarize what was accomplished ` +
  `and what remains, then end your response.]`
```

Then replace the existing stop text at line 247:

```ts
// Before:
content: [{ type: 'text', text: `[Stopped: reached max turns (${maxTurns}).]` }],

// After:
content: [{ type: 'text', text: MAX_TURNS_STOP_TEXT(maxTurns) }],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/agent.test.ts`
Expected: ALL PASS (both old and new maxTurns tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "feat(agent): strengthen maxTurns stop text with CRITICAL enforcement"
```

---

### Task 3: Wire modelId through useConversation.ts

**Files:**
- Modify: `packages/tui/src/hooks/useConversation.ts:204-224`

- [ ] **Step 1: Pass currentModel to buildSystemPrompt and add dependency**

In `packages/tui/src/hooks/useConversation.ts`, modify the `useMemo` block (around line 204):

```ts
// Before:
  const promptInfo = useMemo(() => {
    const sections = loadPromptSections(os.homedir(), cwd)
    const memorySection = sections.find((s) => s.title.startsWith('Memory index'))
    const memoryCount = memorySection
      ? memorySection.content.split('\n').filter((l) => l.startsWith('- [')).length
      : 0
    return {
      systemPrompt: buildSystemPrompt(
        {
          platform: process.platform,
          osVersion: os.release(),
          shell: getShellLabel(),
          cwd,
          date: new Date().toISOString().slice(0, 10),
        },
        sections,
      ),
      memoryCount,
    }
  }, [cwd])

// After:
  const promptInfo = useMemo(() => {
    const sections = loadPromptSections(os.homedir(), cwd)
    const memorySection = sections.find((s) => s.title.startsWith('Memory index'))
    const memoryCount = memorySection
      ? memorySection.content.split('\n').filter((l) => l.startsWith('- [')).length
      : 0
    return {
      systemPrompt: buildSystemPrompt(
        {
          platform: process.platform,
          osVersion: os.release(),
          shell: getShellLabel(),
          cwd,
          date: new Date().toISOString().slice(0, 10),
        },
        sections,
        currentModel,
      ),
      memoryCount,
    }
  }, [cwd, currentModel])
```

- [ ] **Step 2: Run full test suite to verify no regressions**

Run: `cd packages/core && npx vitest run && cd ../tui && npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/hooks/useConversation.ts
git commit -m "feat(tui): pass currentModel to buildSystemPrompt for tiered overlay"
```

---

### Task 4: Export cleanup and full verification

**Files:**
- Modify: `packages/core/src/index.ts` (if it re-exports prompt.ts symbols)

- [ ] **Step 1: Check if core/src/index.ts re-exports prompt symbols**

Run: `grep -n "prompt" packages/core/src/index.ts`

If it re-exports `buildSystemPrompt` / `DEFAULT_SYSTEM_PROMPT`, add `NON_CLAUDE_ENFORCEMENT_OVERLAY`, `isClaudeFamily`, and `MAX_TURNS_STOP_TEXT` to the re-export list. If it doesn't re-export prompt symbols, skip this step.

- [ ] **Step 2: Run the full test suite from project root**

Run: `npx vitest run`
Expected: ALL PASS — no regressions anywhere.

- [ ] **Step 3: Final commit (if index.ts was changed)**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export new prompt overlay symbols"
```
