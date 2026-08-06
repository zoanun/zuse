import type { ProviderModule } from './provider-module.js'
import { anthropicProviderModule } from './anthropic-client.js'
import { openaiProviderModule } from './openai-client.js'

/**
 * 内置协议集，**数组顺序即错误提示里「已知协议」的列出顺序**。
 * 加协议 = 新建 client 文件（导出 class + xxxProviderModule）+ 在此 import 并加入数组。
 * 删协议 = 删该文件 + 去掉这里的一行（TS 会用未解析 import 指引你）。
 *
 * 导出名必须**全局唯一**（不能都叫 providerModule）：core/index.ts 是 `export *` 体质，
 * 同名成员会撞 TS2308。这与 tools 包不同 —— 那边 index.ts 全程具名 re-export，故可同名。
 */
export const BUILTIN_PROVIDER_MODULES: ProviderModule[] = [
  anthropicProviderModule,
  openaiProviderModule,
]
