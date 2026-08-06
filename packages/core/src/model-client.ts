import type { Message, StreamEvent, ModelConfig, ProviderConfig } from './types.js'
import type { ToolDefinition } from './tool.js'
import type { ProviderModule } from './provider-module.js'
import { BUILTIN_PROVIDER_MODULES } from './builtin-providers.js'

/**
 * ModelClient 接口 —— 与具体厂商无关的发送消息 API。
 * 返回 AsyncIterable<StreamEvent> 用于流式响应。
 *
 * 实现：AnthropicClient（Phase 1）、OpenAIClient（Phase 6）
 */
export interface ModelClient {
  /**
   * 发送消息并接收流式事件。`tools`（Phase 3）向模型公布可调用的工具；
   * 当它存在时，模型可能产生 `tool-use` 事件。
   *
   * `signal`（可选）：外部中断信号（用户 Esc）。实现须把它接到底层 SDK 请求，
   * 这样流卡死时按 Esc 能真正取消；缺省时退化为不可中断（旧行为）。
   */
  sendMessages(
    messages: Message[],
    config: ModelConfig,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>

  /** 获取模型名称（用于展示） */
  getModel(): string
}

/**
 * 由模块数组建协议索引。协议名重复 = 编程错误，直接抛，不静默让后者覆盖前者
 * （否则「加了个协议但没生效」会变成哑谜）。
 *
 * 抽成独立导出是为了让「重复即抛」这条规则**可被单测直接钉住**（传一张自造的重复表进来断言）。
 * 注意它并没有消除模块求值期抛错：下面的顶层建表若撞上重复协议，照样在 ESM 求值期炸 ——
 * 那是有意的 fail-fast，不是遗漏。
 */
export function buildProviderIndex(modules: ProviderModule[]): Map<string, ProviderModule> {
  const index = new Map<string, ProviderModule>()
  for (const m of modules) {
    if (index.has(m.protocol)) throw new Error(`Duplicate provider protocol: ${m.protocol}`)
    index.set(m.protocol, m)
  }
  return index
}

const INDEX = buildProviderIndex(BUILTIN_PROVIDER_MODULES)

/**
 * 按 provider 协议选具体实现。clients 仅 type-only 依赖本文件，无运行时环。
 *
 * 本函数**不得**出现任何具体协议名 —— 加协议只该动 builtin-providers.ts。
 * provider-registry.test.ts 用 vi.mock 换掉内置表后断言 'anthropic' 必须抛，
 * 正是为了钉死这一点：残留任何 anthropic/openai 兜底分支都会让那条测试红
 * （已做变异测试验证）。
 */
export function createModelClient(provider: ProviderConfig, model: string): ModelClient {
  const mod = INDEX.get(provider.protocol)
  if (!mod) {
    throw new Error(
      `Unknown provider protocol "${provider.protocol}". Known protocols: ${[...INDEX.keys()].join(', ')}`,
    )
  }
  return mod.make(provider, model)
}
