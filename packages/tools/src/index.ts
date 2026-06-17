import { ToolRegistry } from '@zuse/core'
import type { WebSearchConfig } from '@zuse/core'
import { ReadTool } from './read.js'
import { WriteTool } from './write.js'
import { EditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { BashTool } from './bash.js'
import { WebFetchTool } from './webfetch.js'
import { createWebSearchTool } from './websearch.js'
import { createLspTool } from './lsp/index.js'
import { createLspInstallTool } from './lsp/install.js'
import { LspManager } from './lsp/manager.js'
import { createMemoryTool } from './memory.js'
import { createSkillTool, type SkillEntry } from './skills.js'

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
export { createScheduleWakeupTool, type ScheduleWakeupDeps } from './schedule-wakeup.js'
export { createWebSearchTool } from './websearch.js'
export { createLspTool } from './lsp/index.js'
export { createLspInstallTool } from './lsp/install.js'
export { LspManager } from './lsp/manager.js'

/** createDefaultRegistry 的可选项。 */
export interface DefaultRegistryOptions {
  /** WebSearch 配置；非 null 时才注册 WebSearch 工具（没 key 就不暴露给模型）。 */
  webSearch?: WebSearchConfig | null
  /** LSP 进程池；传入时注册 Lsp 工具（无条件可注册，没装服务器是运行时错误）。 */
  lsp?: LspManager
  /** Memory 工具的项目归属(会话起始 cwd 的 slug;缺省空串 = 全局,Phase 13)。 */
  memoryProject?: string
  /** 已扫描的技能清单(App 启动时 scanSkills 产出;非空才注册 Skill 工具,Phase 14)。 */
  skills?: SkillEntry[]
}

/**
 * 构建一个预装好 v1 工具集的登记表：读/写/改/找文件/搜内容/跑命令/抓网页。
 * 不含独立的 LS 工具 —— 与 Claude Code 对齐：CC 没有 LS 工具，列目录走 `Bash(ls)`。
 * WebSearch 需要 apiKey，故只在传入 webSearch 配置时按需注册（见 DefaultRegistryOptions）。
 */
export function createDefaultRegistry(opts: DefaultRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(ReadTool)
  registry.register(WriteTool)
  registry.register(EditTool)
  registry.register(GlobTool)
  registry.register(GrepTool)
  registry.register(BashTool)
  registry.register(WebFetchTool)
  // Memory 无条件注册:不需要任何 key,库文件懒创建(不用记忆的会话不碰 sqlite)。
  registry.register(createMemoryTool(opts.memoryProject ?? ''))
  // Skill 只在有技能时注册:空清单的工具是纯噪音。
  if (opts.skills && opts.skills.length > 0) registry.register(createSkillTool(opts.skills))
  if (opts.webSearch) registry.register(createWebSearchTool(opts.webSearch))
  if (opts.lsp) {
    registry.register(createLspTool(opts.lsp))
    // LspInstall 与 Lsp 同生命周期:Lsp 报「server 没装」时,模型可调它(经用户确认)安装。
    registry.register(createLspInstallTool())
  }
  return registry
}
