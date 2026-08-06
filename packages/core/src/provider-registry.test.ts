import { describe, it, expect, vi } from 'vitest'

/**
 * R4 的价值主张锁：**默认路径**（createModelClient 不带任何注入）必须是纯数据驱动的 ——
 * 内置表里有什么协议，就只认什么协议。
 *
 * 做法是把 builtin-providers.js 整个换成一张假表，然后断言两件事：
 * 假协议能解析、而真实的 'anthropic' 必须抛。后者才是关键 —— 只要 model-client.ts 里
 * 残留任何形如 `if (protocol === 'anthropic') return new AnthropicClient(...)` 的兜底分支，
 * 这条就会红。（设计评审阶段做过变异测试验证：干净实现全绿，塞回兜底后此条失败。）
 *
 * 单独成文件是必须的：vi.mock 是文件级的，与 model-client.test.ts 里
 * 「anthropic → AnthropicClient」那两条断言不能共存（那两条需要真表）。
 */
vi.mock('./builtin-providers.js', () => ({
  // 假模块必须**内联在工厂里**：vi.mock 被 hoist 到所有 import 之上，
  // 引用文件顶层的常量会炸 ReferenceError: Cannot access '...' before initialization。
  BUILTIN_PROVIDER_MODULES: [
    {
      protocol: 'fake',
      make: (_provider: unknown, model: string) => ({
        tag: 'FAKE' as const,
        getModel: () => model,
        sendMessages: () => {
          throw new Error('not used')
        },
      }),
    },
  ],
}))

const { createModelClient } = await import('./model-client.js')

const cfg = (protocol: string) => ({ id: 'x', protocol, baseURL: 'https://h', apiKey: 'k', models: [] })

describe('provider 注册表 —— 默认路径数据驱动', () => {
  it('内置表里的自造协议能被解析', () => {
    const c = createModelClient(cfg('fake'), 'm') as unknown as { tag: string; getModel(): string }
    expect(c.tag).toBe('FAKE')
    expect(c.getModel()).toBe('m')
  })

  it('内置表里没有 anthropic 时必须抛 —— 锁住 model-client.ts 无残留硬编码', () => {
    expect(() => createModelClient(cfg('anthropic'), 'm')).toThrow('Unknown provider protocol "anthropic"')
  })
})
