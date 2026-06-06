/**
 * Lsp 工具试跑脚本：绕过 TUI 与模型，直接喂参数调 tool.run，打印原始输出。
 *
 * 用法：
 *   npx tsx scripts/try-lsp.ts <operation> <file> <symbol> [line]
 *   operation ∈ definition | references | hover
 *
 * 例：
 *   npx tsx scripts/try-lsp.ts definition packages/tools/src/lsp/__fixtures__/sample.ts greet 6
 *   npx tsx scripts/try-lsp.ts references packages/tools/src/lsp/__fixtures__/sample.ts greet
 *   npx tsx scripts/try-lsp.ts hover      packages/tools/src/lsp/__fixtures__/sample.ts greet 1
 *
 * 语言服务器须在 PATH 上。TS 为方便起见，本脚本会把仓库自带的
 * typescript-language-server（@zuse/tools 的 devDependency）所在 .bin 前置到 PATH；
 * 其它语言（py/go/rust/java/...）需自行全局安装对应服务器。
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
// 根包未依赖 workspace 包，scripts 下按包名解析不到，直接走相对路径导入 src。
import { createFileTracker, type ToolContext } from '../packages/core/src/index.ts'
import { createLspTool, LspManager } from '../packages/tools/src/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')

// 把仓库自带 tsls 的 .bin 前置到 PATH（仅为 TS 试跑方便）。
const bundledBin = path.join(repoRoot, 'packages', 'tools', 'node_modules', '.bin')
if (existsSync(bundledBin)) {
  process.env.PATH = bundledBin + path.delimiter + (process.env.PATH ?? '')
}

const [operation, file, symbol, lineRaw] = process.argv.slice(2)
if (!operation || !file || !symbol) {
  console.error('用法: npx tsx scripts/try-lsp.ts <definition|references|hover> <file> <symbol> [line]')
  process.exit(1)
}
const line = lineRaw ? Number(lineRaw) : undefined

const manager = new LspManager()
const tool = createLspTool(manager)
// cwd 用仓库根，file 走相对路径解析。
const ctx: ToolContext = {
  cwd: repoRoot,
  signal: new AbortController().signal,
  tracker: createFileTracker(),
}

try {
  console.error(`> Lsp ${operation} ${file} ${symbol}${line ? ` (line ${line})` : ''}\n`)
  const r = await tool.run({ operation, file, symbol, line }, ctx)
  console.log(r.output)
  if (r.isError) console.error('\n[isError=true]')
} finally {
  // 务必 dispose，避免遗留语言服务器子进程。
  await manager.dispose()
}
