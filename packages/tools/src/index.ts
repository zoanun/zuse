import { ToolRegistry } from '@zuse/core'
import { ReadTool } from './read.js'
import { WriteTool } from './write.js'
import { EditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { BashTool } from './bash.js'
import { WebFetchTool } from './webfetch.js'

export { ReadTool, WriteTool, EditTool, GlobTool, GrepTool, BashTool, WebFetchTool }
export { getShellLabel } from './bash.js'

/**
 * 构建一个预装好 v1 工具集的登记表：读/写/改/找文件/搜内容/跑命令。
 * 不含独立的 LS 工具 —— 与 Claude Code 对齐：CC 没有 LS 工具，列目录走 `Bash(ls)`。
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(ReadTool)
  registry.register(WriteTool)
  registry.register(EditTool)
  registry.register(GlobTool)
  registry.register(GrepTool)
  registry.register(BashTool)
  registry.register(WebFetchTool)
  return registry
}
