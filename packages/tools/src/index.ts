import { ToolRegistry } from '@zuse/core'
import { ReadTool } from './read.js'
import { WriteTool } from './write.js'
import { EditTool } from './edit.js'
import { LSTool } from './ls.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { BashTool } from './bash.js'

export { ReadTool, WriteTool, EditTool, LSTool, GlobTool, GrepTool, BashTool }

/** 构建一个预装好 v1 工具集的登记表。Phase 4：读/写/改/列/找文件/搜内容/跑命令。 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(ReadTool)
  registry.register(WriteTool)
  registry.register(EditTool)
  registry.register(LSTool)
  registry.register(GlobTool)
  registry.register(GrepTool)
  registry.register(BashTool)
  return registry
}
