---
name: zuse-tests
description: Use when running, filtering, or debugging tests in the zuse monorepo — the setup is non-obvious (root-level vitest, web tested separately, the server package has no test script, and skills.test has a known environmental failure). Reach for this before guessing a test command.
---

# Running tests in the zuse monorepo

This repo's tests don't run the way you'd guess. Follow this instead of inventing a command.

## core / tools / server / protocol tests

Run from the **repo root** with vitest, filtering by a path **substring**:

```
npx vitest run --root E:/ai-study/zuse <substring>
```

- The root `vitest.config.ts` includes `packages/*/src/**/*.test.ts` and **excludes** `packages/web/**`.
- `packages/server` has **no `test` script** — never `pnpm --filter @zouyj/zuse-server test`; use the root command above.
- The filter is a path substring, not a glob: `server.test` also matches `wsServer.test.ts`. Narrow with a longer substring (e.g. `src/http/server.test`) when needed.

## web tests (separate runner)

The web package runs its own vitest (jsdom):

```
pnpm --filter @zuse/web test
```

## typecheck (per package, fast)

```
pnpm --filter @zuse/<pkg> typecheck
```

where `<pkg>` is one of `@zuse/protocol`, `@zuse/core`, `@zuse/tools`, `@zouyj/zuse-server`, `@zuse/web`.

## known false failure — don't chase it

`packages/tools/src/skills.test.ts` fails **6 of 11** `scanSkills` discovery tests *in this dev environment*: `scanSkills` walks the cwd ancestor chain up through the real `~/.zuse/skills`, so it picks up the developer's actual machine skills (weather, deploy, …) that the fixtures don't expect. This is **environmental, not a regression** — the 5 `createSkillTool` tests in the same file should still pass. Prove a change is clean by running the *specific* test files it touches, not this one.
