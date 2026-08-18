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
export * from './trusted-roots.js'
export * from './proxy.js'
export * from './permission.js'
export { killTree, killTreeHard, killTreeSync } from './kill-tree.js'
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
// **`workflow.ts` 刻意不从这里导出。** 它是一个完整实现但**零生产调用方**的子系统
// （291 行实现 + 570 行测试，没有任何工具/命令/接口接上它）。留着代码是因为它没有已知缺陷、
// 测试也是绿的；但把它挂在公共 barrel 上等于让一个没人用的东西成为 @zuse/core 的 API 面。
// 要接它的时候，从这里加回来 —— 那一刻它需要一份自己的 spec 和评审。
export * from './mcp-transport.js'
export * from './mcp-client.js'
export * from './mcp-registry.js'
export * from './failoverCore.js'
