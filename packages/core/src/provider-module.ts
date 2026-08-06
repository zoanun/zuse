import type { ProviderConfig } from './types.js'
import type { ModelClient } from './model-client.js'

/**
 * 一个模型协议的自声明：协议标识 + 如何构造 client。
 * 加一个协议 = 新建 client 文件（导出 class + 本形状的模块）+ 在 builtin-providers.ts 加一行。
 *
 * 本文件**保持纯类型**（无运行时导出）：各 client 文件 type-only 引用它，
 * 回边被 tsconfig 的 verbatimModuleSyntax 强制擦除，故不产生运行时环。
 * 建索引的 buildProviderIndex 因此住在 model-client.ts，不在这里。
 */
export interface ProviderModule {
  /** 协议标识，即 settings 里 providers[].protocol 的取值。 */
  protocol: string
  /**
   * 构造该协议的 client。**必须是闭包**：直接持类引用（如 `ctor: AnthropicClient`）
   * 在常量声明早于 class 声明时会踩 TDZ，模块求值期就抛 ReferenceError。
   */
  make(provider: ProviderConfig, model: string): ModelClient
}
