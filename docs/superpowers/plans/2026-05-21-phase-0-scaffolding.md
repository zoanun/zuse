# Phase 0: Scaffolding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the empty Zuse monorepo so that (1) `pnpm install` works, (2) Ink renders "Hello World" in the terminal, (3) a smoke test passes via Vitest, and (4) a script can successfully call the Anthropic API.

**Architecture:** pnpm workspace with three packages (`@zuse/core`, `@zuse/tools`, `@zuse/tui`). TypeScript with ESM modules. Code runs directly via `tsx` (no build step in dev). Shared `tsconfig.base.json` extended by each package. Vitest at the root for all package tests.

**Tech Stack:** Node.js 22 (Volta-pinned), pnpm 9, TypeScript 5, tsx, Ink 5 + React 18, Vitest 2, `@anthropic-ai/sdk`, ESLint 9 (flat config) + Prettier.

---

## File Structure (end state of Phase 0)

```
zuse/
├── .gitignore
├── .prettierrc.json
├── README.md
├── BACKLOG.md
├── eslint.config.js
├── package.json                 # root, private, workspaces
├── pnpm-workspace.yaml
├── tsconfig.base.json           # shared compiler options
├── vitest.config.ts             # root vitest config
├── .env.example                 # example env, real .env is gitignored
├── docs/
│   └── superpowers/
│       ├── specs/2026-05-21-zuse-design.md   # already committed
│       └── plans/2026-05-21-phase-0-scaffolding.md  # THIS FILE
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/index.ts
│   │   └── src/version.test.ts
│   ├── tools/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   └── tui/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.tsx        # CLI entry
│           └── App.tsx          # Ink root component
└── scripts/
    └── ping-anthropic.ts        # standalone API smoke test
```

---

## Task 1: Repository housekeeping

**Files:**

- Create: `.gitignore`
- Create: `README.md`
- Create: `BACKLOG.md`

- [ ] **Step 1.1: Install pnpm via Volta**

Run:

```bash
volta install pnpm@9
```

Expected: prints `success: installed and set pnpm@9.x.x as default` (or similar). Verify with `pnpm --version`, should print `9.x.x`.

- [ ] **Step 1.2: Create `.gitignore`**

Content:

```
# deps
node_modules/

# build output
dist/
*.tsbuildinfo

# env
.env
.env.local
.env.*.local

# logs
*.log
npm-debug.log*
pnpm-debug.log*

# editor/OS
.DS_Store
.vscode/
.idea/
Thumbs.db

# test coverage
coverage/
```

- [ ] **Step 1.3: Create `README.md`**

Content:

```markdown
# Zuse

A self-built coding agent CLI. Learning project + daily-use tool.

See [design spec](docs/superpowers/specs/2026-05-21-zuse-design.md) for goals and roadmap.

## Status

Phase 0: Scaffolding.
```

- [ ] **Step 1.4: Create `BACKLOG.md`**

Content:

```markdown
# Backlog

Ideas that came up during development but aren't in scope for the current phase.
Review at the end of each phase to decide if any are worth pulling forward.

## Ideas

- (none yet)
```

- [ ] **Step 1.5: Commit**

```bash
git add .gitignore README.md BACKLOG.md
git commit -m "chore: add gitignore, readme, backlog (phase 0.1)"
```

---

## Task 2: pnpm workspace and root package.json

**Files:**

- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`

- [ ] **Step 2.1: Create `pnpm-workspace.yaml`**

Content:

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 2.2: Create root `package.json`**

Content:

```json
{
  "name": "zuse-monorepo",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "engines": {
    "node": ">=22.0.0"
  },
  "volta": {
    "node": "22.22.0",
    "pnpm": "9.15.0"
  },
  "scripts": {
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@typescript-eslint/eslint-plugin": "^8.15.0",
    "@typescript-eslint/parser": "^8.15.0",
    "eslint": "^9.15.0",
    "prettier": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.15.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2.3: Install dependencies**

Run:

```bash
pnpm install
```

Expected: creates `node_modules/` and `pnpm-lock.yaml`. No errors.

- [ ] **Step 2.4: Verify pnpm sees the (currently empty) workspace**

Run:

```bash
pnpm list --depth=-1
```

Expected: shows root package `zuse-monorepo@0.0.0` and the dev dependencies. No workspace packages yet (we add them in later tasks).

- [ ] **Step 2.5: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore: pnpm workspace + root deps (phase 0.1)"
```

---

## Task 3: Shared TypeScript and Prettier config

**Files:**

- Create: `tsconfig.base.json`
- Create: `.prettierrc.json`

- [ ] **Step 3.1: Create `tsconfig.base.json`**

Content:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowJs": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": true,
    "jsx": "react-jsx"
  }
}
```

Notes:

- `noEmit: true` because we use `tsx` to run; if a package later wants to build, it sets `"noEmit": false` and `"outDir": "./dist"` in its own tsconfig.
- `moduleResolution: "Bundler"` avoids the `.js`-extension-in-imports tax during dev.
- `jsx: "react-jsx"` is needed for Ink (uses React).

- [ ] **Step 3.2: Create `.prettierrc.json`**

Content:

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "endOfLine": "lf"
}
```

- [ ] **Step 3.3: Verify Prettier runs**

Run:

```bash
pnpm format:check
```

Expected: lists existing files and reports they match style (or asks to format — that's also fine, just run `pnpm format` after if so).

- [ ] **Step 3.4: Commit**

```bash
git add tsconfig.base.json .prettierrc.json
git commit -m "chore: shared tsconfig + prettier config (phase 0.1)"
```

---

## Task 4: ESLint flat config

**Files:**

- Create: `eslint.config.js`

- [ ] **Step 4.1: Create `eslint.config.js`**

Content:

```js
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'pnpm-lock.yaml'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
```

- [ ] **Step 4.2: Verify ESLint runs (will find no files yet — that's fine)**

Run:

```bash
pnpm lint
```

Expected: completes with no errors (no TS files yet to lint). If it complains about missing source files, that's OK at this stage — proceed.

- [ ] **Step 4.3: Commit**

```bash
git add eslint.config.js
git commit -m "chore: eslint flat config (phase 0.1)"
```

---

## Task 5: Create @zuse/core package

**Files:**

- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`

- [ ] **Step 5.1: Create `packages/core/package.json`**

Content:

```json
{
  "name": "@zuse/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

Note: `exports` points at the `.ts` source. This works because consumers run via `tsx`. When we build for production later, we'll add `dist/` and switch the export.

- [ ] **Step 5.2: Create `packages/core/tsconfig.json`**

Content:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 5.3: Create `packages/core/src/index.ts`**

Content:

```ts
export const VERSION = '0.0.0'
```

- [ ] **Step 5.4: Re-install so pnpm picks up the new workspace package**

Run:

```bash
pnpm install
```

Expected: pnpm-lock updates, `@zuse/core` is now a workspace package.

- [ ] **Step 5.5: Typecheck the package**

Run:

```bash
pnpm -F @zuse/core typecheck
```

Expected: no output, exit code 0.

- [ ] **Step 5.6: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): create empty @zuse/core package (phase 0.2)"
```

---

## Task 6: Create @zuse/tools package

**Files:**

- Create: `packages/tools/package.json`
- Create: `packages/tools/tsconfig.json`
- Create: `packages/tools/src/index.ts`

- [ ] **Step 6.1: Create `packages/tools/package.json`**

Content:

```json
{
  "name": "@zuse/tools",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@zuse/core": "workspace:*"
  }
}
```

- [ ] **Step 6.2: Create `packages/tools/tsconfig.json`**

Content:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 6.3: Create `packages/tools/src/index.ts`**

Content:

```ts
export {}
```

(intentionally empty for now — Phase 3 fills this in)

- [ ] **Step 6.4: Install + typecheck**

Run:

```bash
pnpm install
pnpm -F @zuse/tools typecheck
```

Expected: install completes with `@zuse/tools` linked to `@zuse/core` via workspace protocol; typecheck has no output.

- [ ] **Step 6.5: Commit**

```bash
git add packages/tools pnpm-lock.yaml
git commit -m "feat(tools): create empty @zuse/tools package (phase 0.2)"
```

---

## Task 7: Create @zuse/tui package (Ink Hello World)

**Files:**

- Create: `packages/tui/package.json`
- Create: `packages/tui/tsconfig.json`
- Create: `packages/tui/src/App.tsx`
- Create: `packages/tui/src/index.tsx`

- [ ] **Step 7.1: Create `packages/tui/package.json`**

Content:

```json
{
  "name": "@zuse/tui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "zuse": "./src/index.tsx"
  },
  "scripts": {
    "dev": "tsx src/index.tsx",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@zuse/core": "workspace:*",
    "@zuse/tools": "workspace:*",
    "ink": "^5.0.1",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0"
  }
}
```

- [ ] **Step 7.2: Create `packages/tui/tsconfig.json`**

Content:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 7.3: Create `packages/tui/src/App.tsx`**

Content:

```tsx
import { Box, Text } from 'ink'
import { VERSION } from '@zuse/core'

export function App() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan">Hello from Zuse</Text>
      <Text dimColor>core version: {VERSION}</Text>
    </Box>
  )
}
```

- [ ] **Step 7.4: Create `packages/tui/src/index.tsx`**

Content:

```tsx
#!/usr/bin/env tsx
import { render } from 'ink'
import { App } from './App.js'

render(<App />)
```

Note: the import uses `./App.js` even though the file is `.tsx` — this is the Node ESM convention and TypeScript understands it. (With `moduleResolution: Bundler` we could also drop the extension; keeping `.js` here makes the future build step painless.)

- [ ] **Step 7.5: Install and typecheck**

Run:

```bash
pnpm install
pnpm -F @zuse/tui typecheck
```

Expected: install brings in `ink`, `react`, `@types/react`. Typecheck has no output.

- [ ] **Step 7.6: Run the TUI**

Run:

```bash
pnpm -F @zuse/tui dev
```

Expected: prints two lines to the terminal — `Hello from Zuse` (in cyan) and `core version: 0.0.0` (dimmed). The process should exit on its own after rendering since there's no input loop. If it hangs, press Ctrl+C.

- [ ] **Step 7.7: Commit**

```bash
git add packages/tui pnpm-lock.yaml
git commit -m "feat(tui): ink hello world (phase 0.3)"
```

---

## Task 8: Vitest setup + smoke test in @zuse/core

**Files:**

- Create: `vitest.config.ts`
- Create: `packages/core/src/version.test.ts`

- [ ] **Step 8.1: Create root `vitest.config.ts`**

Content:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 8.2: Write the smoke test in `packages/core/src/version.test.ts`**

Content:

```ts
import { describe, it, expect } from 'vitest'
import { VERSION } from './index.js'

describe('VERSION', () => {
  it('is the placeholder 0.0.0 during phase 0', () => {
    expect(VERSION).toBe('0.0.0')
  })
})
```

- [ ] **Step 8.3: Run the test to verify it passes**

Run:

```bash
pnpm test
```

Expected output (something like):

```
 ✓ packages/core/src/version.test.ts (1)
   ✓ VERSION (1)
     ✓ is the placeholder 0.0.0 during phase 0

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

- [ ] **Step 8.4: Commit**

```bash
git add vitest.config.ts packages/core/src/version.test.ts
git commit -m "test(core): vitest smoke test (phase 0)"
```

---

## Task 9: Anthropic API ping script

**Files:**

- Create: `.env.example`
- Create: `scripts/ping-anthropic.ts`
- Modify: root `package.json` (add `@anthropic-ai/sdk` dep and `ping` script)

- [ ] **Step 9.1: Add `@anthropic-ai/sdk` to root devDependencies**

Run:

```bash
pnpm add -D -w @anthropic-ai/sdk
```

Expected: installs the SDK, updates root `package.json` and `pnpm-lock.yaml`. The `-w` flag (or `--workspace-root`) tells pnpm to add to the root, not a sub-package.

- [ ] **Step 9.2: Add the `ping` script to root `package.json`**

In root `package.json`, add to the `"scripts"` object:

```json
"ping": "tsx scripts/ping-anthropic.ts"
```

- [ ] **Step 9.3: Create `.env.example`**

Content:

```
# Copy this file to .env and fill in your real key.
ANTHROPIC_API_KEY=sk-ant-...
```

- [ ] **Step 9.4: Create your real `.env` (NOT committed)**

Create `.env` in repo root with your actual Anthropic API key:

```
ANTHROPIC_API_KEY=<your real key here>
```

Verify it's gitignored:

```bash
git check-ignore .env
```

Expected: prints `.env`. (If it prints nothing, the file is NOT being ignored — fix `.gitignore` before continuing.)

- [ ] **Step 9.5: Create `scripts/ping-anthropic.ts`**

Content:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Minimal .env loader — no dotenv dependency needed for one-off script.
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

loadDotEnv(resolve(process.cwd(), '.env'))

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

const client = new Anthropic({ apiKey })

async function main() {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '(no text)'

  console.log('Model:', response.model)
  console.log('Stop reason:', response.stop_reason)
  console.log('Usage:', response.usage)
  console.log('Response text:', text)
}

main().catch((err) => {
  console.error('Ping failed:', err)
  process.exit(1)
})
```

- [ ] **Step 9.6: Run the ping**

Run:

```bash
pnpm ping
```

Expected output (approximately):

```
Model: claude-haiku-4-5-20251001
Stop reason: end_turn
Usage: { input_tokens: 12, output_tokens: 3, ... }
Response text: pong
```

If you see `Ping failed:` followed by an error, the most common causes are:

- API key invalid → re-check `.env`
- Network/proxy issues → check your connection
- Model name retired → update the `model` field (current default for the project is Haiku 4.5, ID `claude-haiku-4-5-20251001`)

- [ ] **Step 9.7: Commit**

```bash
git add .env.example scripts/ping-anthropic.ts package.json pnpm-lock.yaml
git commit -m "feat: anthropic api ping script (phase 0.4)"
```

⚠️ Verify `git status` shows no `.env` staged. If `.env` accidentally got staged, run `git restore --staged .env` before committing.

---

## Task 10: Phase 0 wrap-up

- [ ] **Step 10.1: Run full check**

Run each in order, confirm all pass:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm -F @zuse/tui dev   # visual verification: prints Hello from Zuse
pnpm ping               # confirms Anthropic API works
```

- [ ] **Step 10.2: Tag Phase 0**

```bash
git tag v0.1-phase0
git push origin master --tags
```

- [ ] **Step 10.3: Update `README.md` status line**

In `README.md`, change `Phase 0: Scaffolding.` to `Phase 0: Done. Next: Phase 1 — single-turn conversation.`

Commit:

```bash
git add README.md
git commit -m "docs: phase 0 complete, advance status"
git push
```

- [ ] **Step 10.4: Update main design document with fault mode reference**

Add a reference to the supplement document in `2026-05-21-zuse-design.md`:
At the end of section "8. 风险与未决问题", add:

```markdown
### 8.1 故障模式防御矩阵（参见补充文档）

详细的故障模式防御矩阵见 [2026-05-23-zuse-design-supplement.md](./2026-05-23-zuse-design-supplement.md) 第一章。
该矩阵定义了8个故障模式及其对应的Zuse应对措施和实现Phase。
```

Commit:

```bash
git add docs/superpowers/specs/2026-05-21-zuse-design.md
git commit -m "docs: link fault mode matrix from supplement"
```

---

## What's NOT in Phase 0 (deferred)

- `dotenv` package (we wrote a 10-line loader to avoid a dep)
- Real CLI argument parsing (no need yet)
- Conversation state, tools, agent loop — all in Phase 1+
- Production build step (`tsc --build` etc.) — `tsx` is enough for dev
- CI workflows — not until Phase 5 per spec
- GitHub Actions / pre-commit hooks — same

If any of these come up during execution, add them to `BACKLOG.md` and move on.

---

## Done Criteria

Phase 0 is done when ALL of these are true:

1. `pnpm install` produces no errors from a clean clone.
2. `pnpm test` shows the 1 smoke test passing.
3. `pnpm -F @zuse/tui dev` renders "Hello from Zuse" + the core version.
4. `pnpm ping` prints `Response text: pong` (or equivalent).
5. `pnpm typecheck` and `pnpm lint` are clean.
6. The repo is tagged `v0.1-phase0` and pushed.
