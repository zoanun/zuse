/**
 * Skills 系统(Phase 14)—— 把「某类任务的流程知识」从系统提示词搬出来按需加载:
 * 不用时零 token,用时全文进上下文。
 *
 * 对照 cc-haha src/skills/(六大来源/条件激活/hooks/fork/权限分级)取轻量版:
 * SKILL.md 只认 name/description 两个 frontmatter 字段;双层目录发现(用户级
 * ~/.zuse/skills + 项目级 .zuse/skills 沿 cwd 向上收集,内层同名覆盖外层);
 * 单个 Skill 工具暴露,清单拼在工具描述里(工具定义是系统级稳定前缀,与 prompt
 * cache 天然相容,不必像 CC 那样每轮 system-reminder 重发)。
 * 启动扫一次,不热加载(D5);设计与不做清单见
 * docs/superpowers/specs/2026-06-13-zuse-skills-design.md。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import type { Tool, ToolResult } from '@zuse/core'
import { BUILTIN_SKILLS } from './builtin-skills.js'

/** 技能来源。builtin = 编译进产物(无磁盘文件);user = ~/.zuse/skills;project = cwd 链上的 .zuse/skills。 */
export type SkillSource = 'builtin' | 'user' | 'project'

export interface SkillEntry {
  name: string
  /** 触发的全部依据:模型靠它判断「现在该用这个技能」。 */
  description: string
  /** 技能目录绝对路径(正文里 ${ZUSE_SKILL_DIR} 展开成它);内置技能无磁盘目录,为 ''。 */
  dir: string
  /** SKILL.md 正文(不含 frontmatter)。 */
  body: string
  /**
   * 来源。扫描时即确定并原样传下去 —— 消费方(如 SkillService)不必再用
   * `resolve(dir).startsWith(userRoot)` 这类路径前缀去反推(内置的 dir 为 '',
   * resolve('') 会得到进程 cwd,那样反推必然误判)。
   */
  source: SkillSource
}

/** 技能正文进上下文的截断上限(行边界),与指令文件同级别的窗口护栏。 */
export const SKILL_BODY_CAP = 20_000

/** 工具描述清单里单条 description 的展示上限(对齐 CC 的 250,略收紧)。 */
export const LIST_DESC_CAP = 200

/** 行边界截断(与 core instructions 同策略;几行小逻辑,不跨包共享)。 */
function capAtLineBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text
  const head = text.slice(0, cap)
  const lastNewline = head.lastIndexOf('\n')
  const kept = lastNewline > 0 ? head.slice(0, lastNewline) : head
  return `${kept}\n[truncated: skill body is ${text.length} chars; showing first ${kept.length}]`
}

/**
 * 最小 frontmatter 解析:只支持 `key: 单行值`。两个字段用不上完整 YAML;
 * CC 需要 yaml 库是因为它有 15+ 字段含嵌套 hooks。
 * 起了 `---` 头但没收尾的损坏文件:整体当正文处理(回退路径仍可能救活它)。
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { fields: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { fields: {}, body: raw }
  const fields: Record<string, string> = {}
  for (const line of raw.slice(3, end).split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key && value) fields[key] = value
  }
  const body = raw.slice(end + 4).replace(/^[\r\n]+/, '')
  return { fields, body }
}

/** 正文第一个 `# 标题`(description 的回退来源,对齐 CC)。 */
function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(body)
  return m?.[1]?.trim()
}

/** cwd 向上到根的目录链,外层(根)在前 —— 与 ZUSE.md 的收集规则一致。 */
function ancestorChain(cwd: string): string[] {
  const chain: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    chain.unshift(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return chain
}

/** 读一个技能根目录(<root>/<name>/SKILL.md),损坏/缺文件的条目静默跳过。 */
function scanRoot(root: string, into: Map<string, SkillEntry>, source: 'user' | 'project'): void {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return // 目录不存在 = 该层没有技能
  }
  for (const name of entries) {
    const dir = join(root, name)
    let raw: string
    try {
      raw = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    } catch {
      continue // 没有 SKILL.md 的目录跳过
    }
    const { fields, body } = parseFrontmatter(raw)
    const description = fields['description'] ?? firstHeading(body)
    // 没有任何可触发依据的技能不加载:模型永远不会想起它,是死重。
    if (!description) continue
    const skillName = fields['name'] ?? name
    // 同名覆盖:调用方按外层→内层的顺序扫,后写入者(内层)胜出。
    into.set(skillName, { name: skillName, description, dir, body, source })
  }
}

/**
 * 启动时扫描全部技能。覆盖顺序:内置(最低)→ 用户级 → 项目链外层 → 内层,
 * 内层同名整体替换 —— 与 ZUSE.md「内层更具体」同一原则,但技能不叠加。
 */
export function scanSkills(home: string, cwd: string): SkillEntry[] {
  const map = new Map<string, SkillEntry>()
  // 内置技能优先级最低:在 ~/.zuse/skills/ 或项目 .zuse/skills/ 下建同名技能即可整体覆盖(逃生舱)。
  for (const s of BUILTIN_SKILLS) map.set(s.name, { ...s, dir: '', source: 'builtin' })
  const userRoot = resolve(join(home, '.zuse', 'skills'))
  // Windows 路径不区分大小写,而 resolve 不做大小写归一:homedir() 与 cwd 的盘符/目录名
  // 大小写若不一致(如 c:\users\… vs C:\Users\…),直接比较会漏判。
  const samePath = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  scanRoot(userRoot, map, 'user')
  for (const dir of ancestorChain(cwd)) {
    const root = resolve(join(dir, '.zuse', 'skills'))
    // 主目录常常就在 cwd 的祖先链上(项目放在 ~ 下),那样 ~/.zuse/skills 会被扫第二遍,
    // 把刚标好的 'user' 覆写成 'project'。跳过它:既保住来源标记,也省一次重复扫描。
    // 覆盖优先级不受影响 —— user 根本就该被项目链更内层的同名技能覆盖,而它在两种顺序里
    // 都排在那些目录之前。
    if (samePath(root, userRoot)) continue
    scanRoot(root, map, 'project')
  }
  return [...map.values()]
}

/**
 * Skill 工具:清单拼在 description 里,模型按 description 语义匹配后调用,
 * 返回正文全文(分层加载的第二层是正文里引用的附属文件,模型用 Read 按需取)。
 */
export function createSkillTool(skills: SkillEntry[]): Tool {
  const listing = skills
    .map((s) => {
      const desc = s.description.length > LIST_DESC_CAP ? s.description.slice(0, LIST_DESC_CAP) + '…' : s.description
      return `- ${s.name}: ${desc}`
    })
    .join('\n')

  return {
    name: 'Skill',
    description: `Load a skill: specialized instructions for a specific kind of task, written by the user.
Before replying, scan the skills below. If a skill matches or is even partially relevant to the user's request, you MUST invoke this tool FIRST — BEFORE answering or taking any other action. Err on the side of loading: it is always better to have context you don't need than to miss critical steps or established workflows. Load the skill even if you think you could handle the task without it — skills encode the user's preferred approach, conventions, and quality standards.
Never mention a skill without actually invoking it.
Available skills:
${listing}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from the list in this tool\'s description' },
      },
      required: ['name'],
    },
    readOnly: true, // 读一段指令文本,无副作用,免确认

    async run(input: unknown): Promise<ToolResult> {
      const name = (input as { name?: unknown } | null)?.name
      if (typeof name !== 'string' || !name.trim()) {
        return { output: 'Missing "name" — pick a skill from the list in this tool\'s description.', isError: true }
      }
      const skill = skills.find((s) => s.name === name.trim())
      if (!skill) {
        const names = skills.map((s) => s.name).join(', ') || '(none)'
        return { output: `Unknown skill: ${name}. Available skills: ${names}.`, isError: true }
      }
      // 内置技能没有磁盘文件:不重读盘、不展开 ${ZUSE_SKILL_DIR}、不输出 Base directory。
      // 不只是省一次 syscall —— dir 为 '' 时 join('', 'SKILL.md') 是相对路径 'SKILL.md',
      // readFileSync 会拿它去解析进程 cwd:若 cwd 下恰好有个 SKILL.md,旧路径会把那个
      // 无关文件当成内置技能正文返回。而 Base directory 指向不存在的目录会诱导模型去 Read 它。
      if (skill.source === 'builtin') return { output: capAtLineBoundary(skill.body, SKILL_BODY_CAP) }

      // 调用时重读盘(M3「查看时重新加载」):面板刚改完正文,哪怕本会话没关,模型这次
      // 加载也拿最新内容。读不到则回退到会话启动时缓存的 body。
      let freshBody = skill.body
      try {
        freshBody = parseFrontmatter(readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')).body
      } catch {
        // 文件被删/不可读:用缓存的 body 兜底,工具仍可用
      }
      // ${ZUSE_SKILL_DIR} 展开为技能目录;Windows 反斜杠转正斜杠,避免正文里的
      // 路径进 shell 后被当转义(对齐 CC 的处理)。
      const dirPosix = process.platform === 'win32' ? skill.dir.replace(/\\/g, '/') : skill.dir
      const body = capAtLineBoundary(freshBody.replace(/\$\{ZUSE_SKILL_DIR\}/g, dirPosix), SKILL_BODY_CAP)
      return { output: `Base directory: ${dirPosix}\n\n${body}` }
    },
  }
}

export const toolModule = {
  make: (o) => createSkillTool(o.skills ?? []),
  enabled: (o) => (o.skills?.length ?? 0) > 0,
} satisfies import('./tool-module.js').ToolModule
