import { ReadTool } from './read.js'
import { WriteTool } from './write.js'
import { EditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { BashTool } from './bash.js'
import { WebFetchTool } from './webfetch.js'

export { ReadTool, WriteTool, EditTool, GlobTool, GrepTool, BashTool, WebFetchTool }
export { getShellLabel, primeShellSnapshot } from './bash.js'
// 进程层（proc）——「在某个目录里经系统 shell 跑一条命令并把输出收上来」的平台细节，
// 由 bash.ts 纯提取而来（设计 §1），供将来的 run 服务复用。
// killTree 此前只在包内用（bash / lsp），未从 barrel 转出；run 服务要在 daemon 退出时
// 清理在飞进程，故一并转出。名字取得够独特，避开本仓库踩过的 barrel 撞名（TS2308）。
export {
  spawnShellCommand,
  resolvedShell,
  buildChildEnv,
  ProcOutputDecoder,
  killTree,
  killTreeHard,
  StreamShaper,
  type SpawnShellOptions,
} from './proc/index.js'
// run 服务（步骤 2）。**后端内部机制，本步没有任何界面变化。**
// 建在 proc/ 之上：proc 是一次性、无身份的「跑一条命令收输出」，run 是「长跑、有 id、
// 可重连、有策略」。server 依赖 tools（反过来不行），而步骤 5 要把 run 同时暴露成模型
// 工具 —— 工具住在 tools 里，所以 run 也放这儿，免得那时整个搬家。
export {
  RunRegistry,
  RunLimitError,
  Run,
  StreamDecoder,
  TruncateSink,
  RingSink,
  runEnv,
  SNIPPET_POLICY,
  PROJECT_POLICY,
  planExec,
  EXEC_DIR_PLACEHOLDER,
  type ExecKind,
  type ExecPlan,
  type RunPolicy,
  type RunDeps,
  type RunEvent,
  type RunStatus,
  type EndReason,
  type RunSummary,
  type OutputSink,
} from './run/index.js'
export {
  checkTmuxAvailable,
  ensureTmuxSocket,
  getZuseTmuxEnv,
  getZuseTmuxSocketName,
  isTmuxCommand,
  isTmuxSocketInitialized,
} from './tmux-isolation.js'
export { createSnapshotStore, cwdSlug, type SnapshotStore } from './snapshot.js'
export { createMemoryTool, applyMemoryConsolidation, type ConsolidationApplyOps } from './memory.js'
export { scanSkills, createSkillTool, SKILL_BODY_CAP, type SkillEntry } from './skills.js'
export { BUILTIN_SKILLS, type BuiltinSkill } from './builtin-skills.js'
export { openEpisodeStore, type EpisodeStore, type EpisodeHit } from './episode-store.js'
export {
  openMemoryStore,
  renderMemoryMarkdown,
  sanitizeFtsQuery,
  MEMORY_TYPES,
  type MemoryStore,
  type MemoryRow,
  type MemoryType,
} from './memory-store.js'
export { createAgentTool, type AgentToolDeps } from './agent-tool.js'
export {
  findGitRoot,
  createWorktree,
  hasWorktreeChanges,
  worktreeDiffStat,
  removeWorktree,
  ensureWorktreesDirExcluded,
  type WorktreeInfo,
} from './worktree.js'
export { createScheduleWakeupTool, type ScheduleWakeupDeps } from './schedule-wakeup.js'
export { createTodoWriteTool, type TodoWriteDeps, type TodoItem, type TodoStatus } from './todo.js'
export { createRunOutputTool, type RunOutputDeps } from './run/runOutput.js'
export { createWebSearchTool } from './websearch.js'
export { createLspTool } from './lsp/index.js'
export { createLspInstallTool } from './lsp/install.js'
export { LspManager } from './lsp/manager.js'

// R3（内置工具自注册）：createDefaultRegistry / BUILTIN_TOOL_MODULES 迁至 builtin-tools.ts；
// DefaultRegistryOptions / ToolModule 在 tool-module.ts。这里 re-export 保持对外 API 不变。
export { createDefaultRegistry, BUILTIN_TOOL_MODULES } from './builtin-tools.js'
export type { DefaultRegistryOptions, ToolModule } from './tool-module.js'
