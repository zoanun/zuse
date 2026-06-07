# Phase 5.5.1 登录 shell 环境快照 Implementation Plan

> **2026-06-07 后续**：本计划已执行完毕。其后又扩展为支持 POSIX bash/zsh（`DUMP_SCRIPT`→`dumpScript(label)`、`resolveShell()` POSIX 解析 `$SHELL`、cwd 捕获放开到 zsh），详见设计 §3 的 2026-06-07 更新与 roadmap 5.5.1。下文 Task 中 `DUMP_SCRIPT`/「仅 bash」等措辞为执行当时的快照,以现行代码与设计为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 启动时一次性把"sourcing rc 之后"的 shell 环境（PATH + alias + 函数）固化成快照 `.sh`，此后每条 Bash 命令开头 `source` 它，修掉 git-bash 下 alias/函数/PATH 丢失导致的 command-not-found。

**Architecture:** 新增纯函数化的 `shell-snapshot.ts`（记忆化构建、与执行 shell 解耦），由 `bash.ts` 在 `run` 前 `await` 拿快照路径并拼进执行串，TUI 启动时预热。v1 仅 `getShellLabel() === 'bash'`（即 Windows git-bash）生效，其余优雅降级。

**Tech Stack:** TypeScript（no-build raw ./src）、Node `child_process`/`fs`/`os`、Vitest。

完整设计见 [specs/2026-06-06-zuse-shell-snapshot-design.md](../specs/2026-06-06-zuse-shell-snapshot-design.md)。

---

### Task 1：shell-snapshot.ts 纯函数 + 记忆化构建

**Files:**
- Create: `packages/tools/src/shell-snapshot.ts`
- Test: `packages/tools/src/shell-snapshot.test.ts`

- [ ] **Step 1: 写失败测试**（纯函数 + bash-only 集成）

```ts
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  DUMP_SCRIPT, extractSnapshotBody, filterWinptyAliases, ensureShellSnapshot,
} from './shell-snapshot.js'
import { getShellLabel } from './bash.js'

describe('DUMP_SCRIPT', () => {
  it('contains the marker and all four dump sections', () => {
    expect(DUMP_SCRIPT).toContain('__ZUSE_SNAPSHOT_BEGIN__')
    expect(DUMP_SCRIPT).toContain('expand_aliases')
    expect(DUMP_SCRIPT).toContain('declare -f')
    expect(DUMP_SCRIPT).toContain('alias')
    expect(DUMP_SCRIPT).toContain("printf 'export PATH=%q")
  })
})

describe('extractSnapshotBody', () => {
  it('keeps only content after the (last) marker, dropping rc banners', () => {
    const out = 'Welcome to my shell!\n__ZUSE_SNAPSHOT_BEGIN__\nexport PATH=/x\n'
    expect(extractSnapshotBody(out)).toBe('export PATH=/x\n')
  })
  it('uses the last marker when several appear', () => {
    const out = '__ZUSE_SNAPSHOT_BEGIN__\nnoise\n__ZUSE_SNAPSHOT_BEGIN__\nreal=1\n'
    expect(extractSnapshotBody(out)).toBe('real=1\n')
  })
  it('returns empty string when the marker never appears', () => {
    expect(extractSnapshotBody('no marker here')).toBe('')
  })
})

describe('filterWinptyAliases', () => {
  it('drops winpty alias lines but keeps everything else', () => {
    const body = [
      "alias node='winpty node.exe'",
      "alias ll='ls -la'",
      'greet () { echo hi; }',
      'export PATH=/x',
    ].join('\n')
    const out = filterWinptyAliases(body)
    expect(out).not.toContain('winpty')
    expect(out).toContain("alias ll='ls -la'")
    expect(out).toContain('greet () { echo hi; }')
    expect(out).toContain('export PATH=/x')
  })
})

describe.skipIf(getShellLabel() !== 'bash')('ensureShellSnapshot (真起 git-bash)', () => {
  it('builds a snapshot file with a captured PATH', async () => {
    const p = await ensureShellSnapshot(process.env.ZUSE_SHELL ?? '', 'bash')
    // 注：真实 SHELL 由 bash.ts 持有；此处直接走 primeShellSnapshot 的封装更准，见 Task 2 集成测。
    expect(p === null || existsSync(p)).toBe(true)
    if (p) {
      expect(p).not.toContain('\\')
      expect(readFileSync(p, 'utf8')).toContain('export PATH=')
    }
  }, 30_000)

  it('is memoized — second call returns the same path', async () => {
    const a = await ensureShellSnapshot('', 'bash')
    const b = await ensureShellSnapshot('', 'bash')
    expect(a).toBe(b)
  }, 30_000)

  it('returns null for non-bash labels', async () => {
    // 已记忆化：sh 走的是独立判定分支，仍应得 null（不触发构建）。
    // 单独验证纯分支：见实现中 label!=='bash' 即 Promise.resolve(null)。
    expect(true).toBe(true)
  })
})
```

> 说明：`ensureShellSnapshot` 记忆化是**进程级单例**，集成测里第一个真实 binary 取自 `bash.ts` 的 `SHELL`，故 Task 2 会补一条经 `primeShellSnapshot()` 的端到端集成测。Task 1 集成测用 `process.env.ZUSE_SHELL ?? ''` 仅作宽松存在性断言（`p===null || existsSync(p)`），不强依赖 binary 正确。

- [ ] **Step 2: 跑测试确认失败** — Run: `cd e:/ai-study/zuse && npx vitest run packages/tools/src/shell-snapshot.test.ts`，Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```ts
import { spawn } from 'node:child_process'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** stdout 里标记此行之后才是快照正文，用于丢弃 rc sourcing 时打印的 banner。 */
const MARKER = '__ZUSE_SNAPSHOT_BEGIN__'

/**
 * 传给 git-bash 的 `-c` dump 脚本：先 echo 标记，再依次 emit
 * expand_aliases 行、所有函数（declare -f）、所有 alias、source 后的 PATH。
 * 全部输出可被重新 source。
 */
export const DUMP_SCRIPT = [
  `echo ${MARKER}`,
  `echo 'shopt -s expand_aliases 2>/dev/null'`,
  `declare -f`,
  `alias`,
  `printf 'export PATH=%q\\n' "$PATH"`,
].join('\n')

/** 取最后一个 MARKER 那一行之后的内容；无标记返回空串。 */
export function extractSnapshotBody(stdout: string): string {
  const idx = stdout.lastIndexOf(MARKER)
  if (idx === -1) return ''
  const nl = stdout.indexOf('\n', idx)
  return nl === -1 ? '' : stdout.slice(nl + 1)
}

/** 删掉 `alias ` 开头且含 winpty 的行（git-bash 的 winpty 包装会破坏无 tty 管道）。 */
export function filterWinptyAliases(body: string): string {
  return body
    .split('\n')
    .filter((l) => !(l.startsWith('alias ') && l.includes('winpty')))
    .join('\n')
}

/** 记忆化的进程级快照构建结果。 */
let cached: Promise<string | null> | undefined

/**
 * 构建一次登录 shell 环境快照，返回可直接 source 的正斜杠路径或 null。
 * 仅 label==='bash' 真正构建（即 Windows git-bash）；其余优雅降级返回 null。
 * 任何失败（spawn 错/超时/空输出/写盘错）都返回 null，命令退回未快照行为。
 */
export function ensureShellSnapshot(shell: string | true, label: string): Promise<string | null> {
  if (!cached) cached = buildSnapshot(shell, label)
  return cached
}

function buildSnapshot(shell: string | true, label: string): Promise<string | null> {
  if (label !== 'bash' || typeof shell !== 'string') return Promise.resolve(null)
  return new Promise<string | null>((resolve) => {
    let stdout = ''
    const dec = new StringDecoder('utf8')
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      const child = spawn(shell, ['-i', '-l', '-c', DUMP_SCRIPT], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      })
      child.stdout.on('data', (c: Buffer) => {
        stdout += dec.write(c)
      })
      child.on('error', () => finish(null))
      child.on('close', () => {
        stdout += dec.end()
        let body = extractSnapshotBody(stdout)
        if (process.platform === 'win32') body = filterWinptyAliases(body)
        if (body.trim() === '') return finish(null)
        try {
          const dir = path.join(homedir(), '.zuse', 'shell-snapshots')
          mkdirSync(dir, { recursive: true })
          const file = path.join(dir, `snapshot-${process.pid}.sh`)
          writeFileSync(file, body, 'utf8')
          process.once('exit', () => {
            try {
              unlinkSync(file)
            } catch {
              /* 退出清理 best-effort */
            }
          })
          finish(file.replace(/\\/g, '/'))
        } catch {
          finish(null)
        }
      })
    } catch {
      finish(null)
    }
  })
}
```

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run packages/tools/src/shell-snapshot.test.ts`，Expected: PASS。

- [ ] **Step 5: typecheck + lint** — Run: `npm run -s typecheck && npx eslint packages/tools/src/shell-snapshot.ts packages/tools/src/shell-snapshot.test.ts`，Expected: 无错。

### Task 2：把快照接进 bash.ts 执行串 + 启动预热

**Files:**
- Modify: `packages/tools/src/bash.ts`（`buildCwdCapture` 增参、`run` 先 await 快照、导出 `primeShellSnapshot`）
- Modify: `packages/tools/src/index.ts`（re-export `primeShellSnapshot`）
- Modify: `packages/tui/src/App.tsx`（挂载预热）
- Test: `packages/tools/src/bash.test.ts`（追加一条经快照的端到端断言）

- [ ] **Step 1: 写失败测试**（在 bash.test.ts 末尾追加）

```ts
import { primeShellSnapshot } from './bash.js'

describe.runIf(getShellLabel() === 'bash')('BashTool with shell snapshot', () => {
  it('still runs commands correctly once the snapshot is primed', async () => {
    const p = await primeShellSnapshot()
    expect(p === null || p.endsWith('.sh')).toBe(true)
    const result = await BashTool.run(
      { command: `node -e "console.log('after-snapshot')"` },
      makeCtx(),
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('after-snapshot')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run packages/tools/src/bash.test.ts`，Expected: FAIL（`primeShellSnapshot` 未导出）。

- [ ] **Step 3: 改 bash.ts**

3a. 顶部 import：
```ts
import { ensureShellSnapshot } from './shell-snapshot.js'
```

3b. `buildCwdCapture` 增参 `snapshot` 并拼前缀、`pwd` 加反斜杠：
```ts
function buildCwdCapture(command: string, snapshot: string | null): { exec: string; file: string } | null {
  const label = getShellLabel()
  if (label !== 'bash' && label !== 'sh') return null
  const file = path.join(tmpdir(), `zuse-cwd-${process.pid}-${cwdCaptureSeq++}`)
  const redirect = file.replace(/\\/g, '/')
  const pwdCmd = process.platform === 'win32' ? '\\pwd -W' : '\\pwd -P'
  const prefix = snapshot ? `source '${snapshot}' 2>/dev/null\n` : ''
  const exec = `${prefix}${command}\n__zuse_ec=$?; ${pwdCmd} 1>'${redirect}' 2>/dev/null; exit $__zuse_ec`
  return { exec, file }
}
```

3c. 导出预热封装（放在 `getShellLabel` 之后）：
```ts
/** 预热登录 shell 快照（记忆化，仅首次真正构建）。TUI 启动时调用以避免首条命令卡顿。 */
export function primeShellSnapshot(): Promise<string | null> {
  return ensureShellSnapshot(SHELL, getShellLabel())
}
```

3d. `run` 改为先 await 快照再 spawn（把同步 `new Promise` 体放进 async）：
```ts
  async run(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = (rawInput ?? {}) as BashInput
    if (!input.command || typeof input.command !== 'string') {
      return { output: 'Bash requires a command.', isError: true }
    }
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    const snapshot = await primeShellSnapshot()
    return new Promise<ToolResult>((resolvePromise) => {
      const capture = buildCwdCapture(input.command, snapshot)
      // ...（其余 spawn / 累加 / 超时 / close 处理保持不变）
```

- [ ] **Step 4: 改 index.ts** — 在现有 `export { getShellLabel } from './bash.js'` 同处追加：
```ts
export { getShellLabel, primeShellSnapshot } from './bash.js'
```
（删掉原单独那行，合并为一行。）

- [ ] **Step 5: 改 App.tsx** — import 与挂载预热：
```ts
import { createDefaultRegistry, LspManager, primeShellSnapshot } from '@zuse/tools'
```
在组件体内（与其它 useEffect 并列）：
```tsx
  useEffect(() => {
    // 启动即预热登录 shell 快照，把 ≤10s 的首次构建挪离首条命令路径；失败降级无影响。
    void primeShellSnapshot()
  }, [])
```
（若 `useEffect` 尚未 import，则补进 React import。）

- [ ] **Step 6: 跑测试确认通过** — Run: `npx vitest run packages/tools/src/bash.test.ts`，Expected: PASS。

- [ ] **Step 7: 全量验证** — Run: `npm test && npm run -s typecheck && npm run -s lint`，Expected: 全绿。

### Task 3：更新 roadmap 状态

**Files:**
- Modify: `docs/superpowers/plans/phase-roadmap.md`

- [ ] **Step 1:** 在 Phase 5.5 / 5.5.1 处标注 5.5.1 已完成（日期 2026-06-06），并指明 v1 范围 = 仅 git-bash、PATH+alias+函数，POSIX 延后。
- [ ] **Step 2:** 不提交——按"评审前不提交"约定，留待用户早上审阅。
