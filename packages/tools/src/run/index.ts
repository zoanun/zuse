/**
 * run 服务（`docs/superpowers/specs/2026-08-11-run-registry-step2-design.md`）。
 *
 * 「长跑、有 id、可重连、有策略」的进程管理，建在 `proc/` 之上。
 * `proc/` 是一次性、无身份的「跑一条命令收输出」；两者生命周期模型不同，刻意分成两个目录。
 *
 * **一律具名转出，绝不 `export *`。** 本仓的 barrel 撞过 TS2308（见 CLAUDE.md §四），
 * 而这个目录里有 `childEnv.ts`，与 `proc/env.ts` 只差一个前缀；`export *` 是把那类
 * 撞名重新请回来的最快方式。
 */
export { StreamDecoder, type StreamDecoderOptions } from './stream.js'
export { TruncateSink, RingSink, type OutputSink } from './sink.js'
export { runEnv, type RunEnvOptions } from './childEnv.js'
export { SNIPPET_POLICY, PROJECT_POLICY, type RunPolicy } from './policy.js'
export { planExec, EXEC_DIR_PLACEHOLDER, type ExecKind, type ExecPlan } from './planExec.js'
export {
  Run,
  type RunDeps,
  type RunInit,
  type RunEvent,
  type RunStatus,
  type EndReason,
} from './run.js'
export {
  RunRegistry,
  RunLimitError,
  type RunRegistryOptions,
  type RunSummary,
  type StartRunInit,
} from './registry.js'
