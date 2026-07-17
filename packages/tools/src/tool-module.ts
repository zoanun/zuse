import type { Tool, WebSearchConfig } from '@zuse/core'
import type { LspManager } from './lsp/manager.js'
import type { SkillEntry } from './skills.js'

/** createDefaultRegistry 的可选项（原在 index.ts，迁至此以供各工具模块引用）。 */
export interface DefaultRegistryOptions {
  /** WebSearch 配置；非空才注册 WebSearch（没 key 不暴露给模型）。 */
  webSearch?: WebSearchConfig | null
  /** LSP 进程池；传入时注册 Lsp/LspInstall。 */
  lsp?: LspManager
  /** Memory 工具的项目归属（会话起始 cwd 的 slug；缺省空串 = 全局）。 */
  memoryProject?: string
  /** 已扫描的技能清单；非空才注册 Skill。 */
  skills?: SkillEntry[]
}

/** 一个内置工具的自声明：如何构造、是否启用。删掉工具文件即少一个工具。 */
export interface ToolModule {
  /** 构造工具实例。纯对象工具即 `() => ReadTool`；工厂工具从 opts 取入参。 */
  make(opts: DefaultRegistryOptions): Tool
  /** 是否在本次注册中启用；缺省视为 true（无条件工具不实现它）。 */
  enabled?(opts: DefaultRegistryOptions): boolean
}
