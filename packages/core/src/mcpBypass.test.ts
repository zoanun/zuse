import { describe, it, expect } from 'vitest'
import { decide, isMcpTool } from './permission.js'
import type { Tool } from './tool.js'
import type { ResolvedSettings } from './types.js'

/**
 * **MCP 工具不吃「全自主」那张白卡。**
 *
 * 独立评审实测推翻了我原来的判断（我以为「MCP 一律 ask」就是今天的行为）：
 *
 *   无任何规则, mode=bypass → {"decision":"allow","matched":"bypass"}
 *
 * 也就是说全自主档下 MCP 工具是**无条件自动放行**的。而它们：
 *   - 没有 `readOnly`，也没有路径限定符（`buildMcpTool` 不设 `specifierFor`），
 *     所以带限定符的规则对它们一条都命不中；
 *   - 不过 Bash 那 23 项安全检查（那是按工具名挂的）；
 *   - 一个 filesystem / git / shell 类的 server 就是一个完整的写入面。
 *
 * 这一档零启发式、零猜测：**不猜它要动什么，只是不给它那张白卡。**
 * 用户仍可显式 allow（裸工具名就够），那是他明确表态。
 *
 * 位置与 3.2（必须确认）、3.3（Bash 重定向）同理：必须在 bypass 之前。
 */

const cwd = process.cwd()
const mk = (name: string, over: Partial<Tool> = {}): Tool => ({
  name, description: '', inputSchema: { type: 'object', properties: {} },
  run: async () => ({ output: '' }), ...over,
})

function settings(over: Partial<ResolvedSettings['permissions']> = {}): ResolvedSettings {
  return {
    tools: {}, providers: {},
    permissions: { defaultMode: 'bypass', allow: [], ask: [], deny: [], ...over },
  } as ResolvedSettings
}

describe('识别 MCP 工具', () => {
  it('按 mcp__ 前缀认', () => {
    expect(isMcpTool('mcp__everything__echo')).toBe(true)
    expect(isMcpTool('Bash')).toBe(false)
    expect(isMcpTool('mcp_notreally')).toBe(false)
  })
})

describe('全自主档下 MCP 工具仍要确认', () => {
  const T = mk('mcp__fs__write_file')

  it('没有任何规则 → ask，不是 allow（修之前是 allow）', () => {
    const r = decide(T, null, settings(), [], cwd)
    expect(r.decision).toBe('ask')
    expect(r.matched).toBe('mcp:no-bypass')
  })

  it('用户显式 allow 裸工具名 → 放行（这是他明确表态）', () => {
    expect(decide(T, null, settings({ allow: ['mcp__fs__write_file'] }), [], cwd).decision).toBe('allow')
  })

  it('会话级放行也算数（点过一次「本次会话」）', () => {
    expect(decide(T, null, settings(), ['mcp__fs__write_file'], cwd).decision).toBe('allow')
  })

  it('deny 仍然优先 —— 这一档不该把 deny 顶掉', () => {
    expect(decide(T, null, settings({ deny: ['mcp__fs__write_file'] }), [], cwd).decision).toBe('deny')
  })

  it('非 MCP 工具不受影响：全自主还是全自主', () => {
    expect(decide(mk('Bash'), 'ls', settings(), [], cwd).decision).toBe('allow')
  })

  /**
   * **只用 annotations 收紧，绝不用它放松。** 服务端谎报「我是危险的」只会给自己
   * 找麻烦（没有攻击动机）；谎报「我只读」换取自动放行是**有**动机的，
   * 而这个字段来自不可信的一方。
   */
  it('标了 readOnly 的 MCP 工具**照样**要确认（不信任服务端的自我声明）', () => {
    const ro = mk('mcp__everything__echo', { readOnly: true })
    expect(decide(ro, null, settings(), [], cwd).decision).toBe('ask')
  })
})
