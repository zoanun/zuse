import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolContext } from '@zuse/core'
import { createFileTracker } from '@zuse/core'
import { scanSkills, createSkillTool, SKILL_BODY_CAP } from './skills.js'

let home: string
let proj: string

const ctx = (): ToolContext => ({
  cwd: 'E:\\proj',
  signal: new AbortController().signal,
  tracker: createFileTracker(),
  setCwd: () => {},
})

function writeSkill(root: string, name: string, content: string): void {
  const dir = join(root, '.zuse', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
}

/** 用户级技能目录是 ~/.zuse/skills(无项目前缀的 .zuse)。 */
function writeUserSkill(name: string, content: string): void {
  const dir = join(home, '.zuse', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'zuse-skill-home-'))
  proj = mkdtempSync(join(tmpdir(), 'zuse-skill-proj-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(proj, { recursive: true, force: true })
})

describe('scanSkills(发现与解析)', () => {
  it('无技能目录返回空数组', () => {
    expect(scanSkills(home, proj)).toEqual([])
  })

  it('用户级 + 项目级都发现;frontmatter 解析 name/description', () => {
    writeUserSkill('commit-style', '---\nname: commit-style\ndescription: 提交信息规范\n---\n\n正文 A')
    writeSkill(proj, 'code-review', '---\ndescription: 审查本地改动\n---\n\n正文 B')
    const skills = scanSkills(home, proj)
    expect(skills.map((s) => s.name).sort()).toEqual(['code-review', 'commit-style'])
    const review = skills.find((s) => s.name === 'code-review')!
    expect(review.description).toBe('审查本地改动')
    expect(review.dir).toContain('code-review')
  })

  it('缺 name 取目录名;缺 description 回退正文第一个 # 标题', () => {
    writeUserSkill('fallback-skill', '# 标题即描述\n\n正文')
    const skills = scanSkills(home, proj)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('fallback-skill')
    expect(skills[0]!.description).toBe('标题即描述')
  })

  it('description 与标题都没有的技能跳过(没有触发依据 = 死技能)', () => {
    writeUserSkill('dead-skill', '只有正文没有任何标题')
    expect(scanSkills(home, proj)).toEqual([])
  })

  it('同名技能内层覆盖外层:项目级 > 用户级,包级 > 仓库根', () => {
    const inner = join(proj, 'packages', 'app')
    mkdirSync(inner, { recursive: true })
    writeUserSkill('deploy', '---\ndescription: 用户级部署\n---\nU')
    writeSkill(proj, 'deploy', '---\ndescription: 仓库级部署\n---\nR')
    writeSkill(inner, 'deploy', '---\ndescription: 包级部署\n---\nP')
    const skills = scanSkills(home, inner)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.description).toBe('包级部署')
  })

  it('缺 SKILL.md 的目录与损坏 frontmatter 容忍跳过/降级', () => {
    mkdirSync(join(home, '.zuse', 'skills', 'empty-dir'), { recursive: true })
    // frontmatter 起了头没收尾:当无 frontmatter 处理,回退标题。
    writeUserSkill('broken', '---\nname: broken\n\n# 损坏但有标题\n正文')
    const skills = scanSkills(home, proj)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.description).toBe('损坏但有标题')
  })
})

describe('createSkillTool', () => {
  function makeTool(): Tool {
    writeUserSkill(
      'code-review',
      '---\ndescription: 审查本地改动\n---\n\n# 流程\n参考 ${ZUSE_SKILL_DIR}/checklist.md 逐项检查。',
    )
    writeUserSkill('deploy', '---\ndescription: 部署到生产\n---\n\n部署正文')
    return createSkillTool(scanSkills(home, proj))
  }

  it('工具描述含技能清单与「先调用再作答」触发指引', () => {
    const tool = makeTool()
    expect(tool.readOnly).toBe(true)
    expect(tool.description).toContain('code-review: 审查本地改动')
    expect(tool.description).toContain('deploy: 部署到生产')
    expect(tool.description).toMatch(/BEFORE/i)
  })

  it('run 返回 Base directory + 正文,${ZUSE_SKILL_DIR} 展开为正斜杠绝对路径', async () => {
    const tool = makeTool()
    const res = await tool.run({ name: 'code-review' }, ctx())
    expect(res.isError).toBeFalsy()
    expect(res.output).toMatch(/^Base directory: /)
    expect(res.output).toContain('# 流程')
    expect(res.output).not.toContain('${ZUSE_SKILL_DIR}')
    expect(res.output).toContain('/checklist.md')
    expect(res.output).not.toContain('\\checklist.md') // Windows 路径转正斜杠
  })

  it('未知技能名回 observation,列出可用清单', async () => {
    const tool = makeTool()
    const res = await tool.run({ name: 'nonexistent' }, ctx())
    expect(res.isError).toBe(true)
    expect(res.output).toContain('code-review')
    expect(res.output).toContain('deploy')
  })

  it('超长正文行边界截断', async () => {
    writeUserSkill('huge', `---\ndescription: 巨型技能\n---\n${('x'.repeat(100) + '\n').repeat(400)}`)
    const tool = createSkillTool(scanSkills(home, proj))
    const res = await tool.run({ name: 'huge' }, ctx())
    expect(res.output.length).toBeLessThanOrEqual(SKILL_BODY_CAP + 300)
    expect(res.output).toContain('[truncated:')
  })

  it('缺 name 参数回用法指引', async () => {
    const tool = makeTool()
    const res = await tool.run({}, ctx())
    expect(res.isError).toBe(true)
    expect(res.output).toContain('name')
  })
})
