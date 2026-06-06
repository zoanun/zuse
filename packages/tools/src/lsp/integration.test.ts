import { describe, it, expect, afterAll } from 'vitest'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createFileTracker, type ToolContext } from '@zuse/core'
import { createLspTool } from './index.js'
import { LspManager } from './manager.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(here, '__fixtures__')

/**
 * 定位 devDependency 里 typescript-language-server 的启动器所在的 .bin 目录。
 *
 * pnpm 按包就近放置：tsls 是 @zuse/tools 的 devDependency，启动器在
 * packages/tools/node_modules/.bin（这里向上两级即 packages/tools）。也兜底查仓库根。
 * 找到后把该目录前置到 PATH —— 这样**默认** starter（LspClient.start 按裸名 spawn）
 * 就能解析到它：Windows 上经 LspClient 的 shell 走 cmd.exe + PATHEXT 命中 .CMD，
 * POSIX 上命中无扩展名的 sh 启动器。如此集成测覆盖的是**真实生产 spawn 路径**，
 * 而非绕过 client 的替身,连 Windows 的 .CMD 解析也一并验证。
 */
function resolveBinDir(): string | undefined {
  const candidates = [
    path.join(here, '..', '..', 'node_modules', '.bin'), // packages/tools/node_modules/.bin
    path.join(here, '..', '..', '..', '..', 'node_modules', '.bin'), // 仓库根 node_modules/.bin
  ]
  const names =
    process.platform === 'win32'
      ? ['typescript-language-server.cmd', 'typescript-language-server.CMD']
      : ['typescript-language-server']
  for (const dir of candidates) {
    if (names.some((n) => existsSync(path.join(dir, n)))) return dir
  }
  return undefined
}

const binDir = resolveBinDir()
if (binDir) {
  // spawn 在执行时读取 process.env.PATH，模块加载期前置即可对后续所有 spawn 生效。
  process.env.PATH = binDir + path.delimiter + (process.env.PATH ?? '')
}

function makeCtx(): ToolContext {
  return { cwd: fixtureDir, signal: new AbortController().signal, tracker: createFileTracker() }
}

// 默认 starter（不替身）：完整跑 spawn → initialize 握手 → 就绪 → didOpen → 请求 → dispose。
const manager = new LspManager()
const tool = createLspTool(manager)

// 关键：跑完务必 dispose，避免遗留 typescript-language-server 子进程成为孤儿。
afterAll(async () => {
  await manager.dispose()
})

describe.skipIf(!binDir)('Lsp tool — TS integration（真起 typescript-language-server）', () => {
  it('finds the definition of greet from its call site', async () => {
    // sample.ts 第 6 行 `export const message = greet(who)` 调用 greet，定义在第 1 行。
    const r = await tool.run(
      { operation: 'definition', file: 'sample.ts', symbol: 'greet', line: 6 },
      makeCtx(),
    )
    expect(r.isError).toBeFalsy()
    expect(r.output).toMatch(/sample\.ts:1:/)
  }, 60_000)

  it('finds references to greet', async () => {
    const r = await tool.run(
      { operation: 'references', file: 'sample.ts', symbol: 'greet' },
      makeCtx(),
    )
    expect(r.isError).toBeFalsy()
    expect(r.output).toMatch(/reference/i)
  }, 60_000)

  it('returns hover type info for greet', async () => {
    const r = await tool.run(
      { operation: 'hover', file: 'sample.ts', symbol: 'greet', line: 1 },
      makeCtx(),
    )
    expect(r.isError).toBeFalsy()
    expect(r.output).toMatch(/greet|string/)
  }, 60_000)
})
