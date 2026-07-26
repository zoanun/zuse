import { describe, it, expect } from 'vitest'
import { BUILTIN_SKILLS } from './builtin-skills.js'

const bySkill = (n: string) => BUILTIN_SKILLS.find((s) => s.name === n)!

describe('zuse-config 内置技能', () => {
  const s = () => bySkill('zuse-config')

  it('description 覆盖全部触发场景(模型据此判断何时加载)', () => {
    const d = s().description.toLowerCase()
    for (const kw of ['mcp', 'skill', 'cron', 'model', 'permission', 'persona', 'settings']) {
      expect(d, `description 少了触发词 "${kw}"`).toContain(kw)
    }
  })

  it('正文写清各配置文件路径', () => {
    const b = s().body
    for (const p of [
      '~/.zuse/settings.json',
      'settings.local.json',
      '~/.zuse/skills/',
      '~/.zuse/cron/tasks.json',
      'personas.json',
      'skills-disabled.json',
      'memory.db',
    ]) {
      expect(b, `正文缺路径 ${p}`).toContain(p)
    }
  })

  it('正文写清三层设置的 .jsonc 优先规则', () => {
    const b = s().body
    expect(b).toContain('.jsonc')
    expect(b).toMatch(/优先/)
  })

  it('正文讲清 cron 的手改陷阱与正确入口', () => {
    const b = s().body
    expect(b).toContain('/api/cron')
    expect(b).toMatch(/不要手改/)
    expect(b).toMatch(/不会重排/)
  })

  it('正文含生效时机(重启 / 新会话 / 实时)速查', () => {
    const b = s().body
    expect(b).toMatch(/重启/)
    expect(b).toMatch(/新会话/)
    expect(b).toMatch(/生效时机速查/)
  })
})

describe('zuse-readme 内置技能', () => {
  const s = () => bySkill('zuse-readme')

  it('description 覆盖身份类提问', () => {
    const d = s().description.toLowerCase()
    for (const kw of ['who', 'architecture', 'zuse', '你是谁']) {
      expect(d, `description 少了触发词 "${kw}"`).toContain(kw.toLowerCase())
    }
  })

  it('正文含完整包结构', () => {
    const b = s().body
    for (const p of ['packages/core', 'packages/tools', 'packages/protocol', 'packages/server', 'packages/web', 'packages/tui']) {
      expect(b, `正文缺包 ${p}`).toContain(p)
    }
  })

  it('正文指向权威来源(specs / 源码 / README)', () => {
    const b = s().body
    expect(b).toContain('docs/superpowers/specs/')
    expect(b).toContain('README.md')
    expect(b).toMatch(/ground truth|以代码为准/)
  })

  it('正文诚实声明局限(可能滞后 / 不在仓库时只能答架构级)', () => {
    const b = s().body
    expect(b).toMatch(/滞后/)
    expect(b).toMatch(/架构级/)
    expect(b).toMatch(/不要编造|绝不要编造/)
  })
})

describe('内置技能通用约束', () => {
  it('每个内置技能都有非空 name/description/body,且 name 唯一', () => {
    const names = BUILTIN_SKILLS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    for (const s of BUILTIN_SKILLS) {
      expect(s.name).toBeTruthy()
      expect(s.description.length).toBeGreaterThan(50) // 描述太短模型无从判断触发
      expect(s.body.length).toBeGreaterThan(500)
    }
  })

  it('正文不含未展开的 ${ZUSE_SKILL_DIR}(内置技能无磁盘目录可展开)', () => {
    for (const s of BUILTIN_SKILLS) {
      // 说明性示例里出现是允许的,但不能出现在会误导模型去 Read 的路径引用上下文中;
      // 这里只保证 zuse-readme(纯自述)完全不含它。
      if (s.name === 'zuse-readme') expect(s.body).not.toContain('${ZUSE_SKILL_DIR}')
    }
  })
})
