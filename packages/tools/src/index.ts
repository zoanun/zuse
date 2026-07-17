import { ReadTool } from './read.js'
import { WriteTool } from './write.js'
import { EditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { BashTool } from './bash.js'
import { WebFetchTool } from './webfetch.js'

export { ReadTool, WriteTool, EditTool, GlobTool, GrepTool, BashTool, WebFetchTool }
export { getShellLabel, primeShellSnapshot } from './bash.js'
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
export { createWebSearchTool } from './websearch.js'
export { createLspTool } from './lsp/index.js'
export { createLspInstallTool } from './lsp/install.js'
export { LspManager } from './lsp/manager.js'

// R3（内置工具自注册）：createDefaultRegistry / BUILTIN_TOOL_MODULES 迁至 builtin-tools.ts；
// DefaultRegistryOptions / ToolModule 在 tool-module.ts。这里 re-export 保持对外 API 不变。
export { createDefaultRegistry, BUILTIN_TOOL_MODULES } from './builtin-tools.js'
export type { DefaultRegistryOptions, ToolModule } from './tool-module.js'
