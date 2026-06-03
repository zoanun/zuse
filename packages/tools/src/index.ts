import { ToolRegistry } from '@zuse/core'
import { ReadTool } from './read.js'

export { ReadTool }

/** 构建一个预装好 v1 工具集的登记表。Phase 3：只有 Read。 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(ReadTool)
  return registry
}
