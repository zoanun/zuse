export const VERSION = '0.0.0'

export * from './types.js'
export * from './provider-module.js'
export * from './builtin-providers.js'
export * from './model-client.js'
export * from './anthropic-client.js'
export * from './openai-client.js'
export * from './conversation.js'
export * from './tool.js'
export * from './settings.js'
export * from './proxy.js'
export * from './permission.js'
export { killTree, killTreeSync } from './kill-tree.js'
export {
  trackChild, untrackChild, reapTrackedChildren, armChildReaper,
  // 测试专用，但必须从 barrel 出去：tools 包够不着 core 的内部文件路径
  // （core 的 package.json 没开 subpath exports），而「登记确实发生了」这条
  // 必须在 tools 侧断言 —— 那才是唯一的 spawn 入口。
  __trackedPidsForTest,
} from './child-reaper.js'
export * from './bash-security.js'
export * from './agent.js'
export * from './steer.js'
export * from './prompt.js'
export * from './instructions.js'
export * from './compaction.js'
export * from './title.js'
export * from './memory-consolidation.js'
export * from './workflow.js'
export * from './mcp-transport.js'
export * from './mcp-client.js'
export * from './mcp-registry.js'
export * from './failoverCore.js'
