/**
 * 进程层（proc）—— 「在某个目录里经系统 shell 跑一条命令，并把它的输出安全地收上来」
 * 这件事的全部平台细节。
 *
 * 由 `bash.ts` 纯提取而来，见
 * `docs/superpowers/specs/2026-08-07-code-exec-runner-v3-design.md` §1 与 §10。
 * `bash.ts`（一次性工具调用）与将来的 run 服务（长跑 + 流式）各自在其上加**策略**：
 * 超时、截断预算、落盘位置、错误文案都不属于这一层。
 *
 * 边界说明：
 * - **有界输出 + 落盘** 用 `../truncate.js` 的 `StreamShaper`（它本来就是独立模块、
 *   自带测试，不归 bash 专有），这里只做转出，不再包一层。
 * - **杀进程树** 用 `../util.js` 的 `killTree`（`lsp/client.ts` 也在用，实现留在原处
 *   以免两处分叉），这里同样只做转出，让 run 服务有一个统一的引入面。
 *
 * 用具名转出而**不用 `export *`**：本仓库的 barrel 撞过 TS2308（见 CLAUDE.md §四）。
 */

export { resolveShell, resolvedShell, getShellLabel } from './shell.js'
export { buildChildEnv } from './env.js'
export { winOemLabel, redecodeOemIfMojibake, OEM_RAW_CAP } from './oem.js'
export { ProcOutputDecoder } from './output.js'
export { spawnShellCommand, type SpawnShellOptions, type ShellChildProcess } from './spawn.js'
export { killTree } from '../util.js'
export { StreamShaper, type StreamShaperOptions, type ShapedResult } from '../truncate.js'
