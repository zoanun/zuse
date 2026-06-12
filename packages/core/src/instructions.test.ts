import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPromptSections, INSTRUCTION_FILE_CAP, MEMORY_INDEX_CAP } from './instructions.js'
import { buildSystemPrompt } from './prompt.js'

let home: string
let proj: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'zuse-instr-home-'))
  proj = mkdtempSync(join(tmpdir(), 'zuse-instr-proj-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(proj, { recursive: true, force: true })
})

describe('loadPromptSections', () => {
  it('没有任何指令文件时返回空数组', () => {
    expect(loadPromptSections(home, proj)).toEqual([])
  })

  it('读取 ~/.zuse/SYSTEM.md 作为用户全局指令', () => {
    mkdirSync(join(home, '.zuse'), { recursive: true })
    writeFileSync(join(home, '.zuse', 'SYSTEM.md'), '始终用中文回复。', 'utf8')
    const sections = loadPromptSections(home, proj)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.title).toContain('SYSTEM.md')
    expect(sections[0]!.content).toBe('始终用中文回复。')
  })

  it('ZUSE.md 从 cwd 向上逐级收集,外层在前内层在后', () => {
    // proj/ZUSE.md(外)与 proj/packages/app/ZUSE.md(内),cwd = 内层。
    const inner = join(proj, 'packages', 'app')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(proj, 'ZUSE.md'), '仓库级指令', 'utf8')
    writeFileSync(join(inner, 'ZUSE.md'), '包级指令', 'utf8')
    const sections = loadPromptSections(home, inner)
    expect(sections).toHaveLength(2)
    expect(sections[0]!.content).toBe('仓库级指令') // 外层在前
    expect(sections[1]!.content).toBe('包级指令') // 内层在后(更具体,权重更高)
    expect(sections[0]!.title).toContain('ZUSE.md')
  })

  it('读取 ~/.zuse/MEMORY.md 作为记忆索引,排在最后', () => {
    mkdirSync(join(home, '.zuse'), { recursive: true })
    writeFileSync(join(home, '.zuse', 'SYSTEM.md'), '全局指令', 'utf8')
    writeFileSync(join(home, '.zuse', 'MEMORY.md'), '- [1] 用户偏好 pnpm', 'utf8')
    writeFileSync(join(proj, 'ZUSE.md'), '项目指令', 'utf8')
    const sections = loadPromptSections(home, proj)
    expect(sections.map((s) => s.content)).toEqual(['全局指令', '项目指令', '- [1] 用户偏好 pnpm'])
    expect(sections[2]!.title).toContain('MEMORY.md')
  })

  it('超长指令文件在行边界截断并带标记(窗口护栏)', () => {
    mkdirSync(join(home, '.zuse'), { recursive: true })
    const line = 'x'.repeat(100) + '\n'
    writeFileSync(join(home, '.zuse', 'SYSTEM.md'), line.repeat(300), 'utf8') // 30k 字符
    const sections = loadPromptSections(home, proj)
    expect(sections[0]!.content.length).toBeLessThanOrEqual(INSTRUCTION_FILE_CAP + 200)
    expect(sections[0]!.content).toContain('[truncated:')
    // 行边界:截断标记前应是完整行(以 x 结尾的整行,不是半行)。
    const beforeMarker = sections[0]!.content.slice(0, sections[0]!.content.indexOf('\n[truncated:'))
    expect(beforeMarker.endsWith('x')).toBe(true)
    expect((beforeMarker.split('\n').pop() ?? '').length).toBe(100)
  })

  it('MEMORY.md 用更小的上限(8k)', () => {
    mkdirSync(join(home, '.zuse'), { recursive: true })
    writeFileSync(join(home, '.zuse', 'MEMORY.md'), ('m'.repeat(80) + '\n').repeat(200), 'utf8') // 16k+
    const sections = loadPromptSections(home, proj)
    expect(sections[0]!.content.length).toBeLessThanOrEqual(MEMORY_INDEX_CAP + 200)
  })

  it('空白文件(只有空格换行)不产出 section', () => {
    mkdirSync(join(home, '.zuse'), { recursive: true })
    writeFileSync(join(home, '.zuse', 'SYSTEM.md'), '  \n\n  ', 'utf8')
    expect(loadPromptSections(home, proj)).toEqual([])
  })
})

describe('buildSystemPrompt + sections', () => {
  const env = { platform: 'win32', shell: 'bash', cwd: 'E:\\proj', date: '2026-06-12' }

  it('sections 追加在环境块之后,带 ## 标头', () => {
    const out = buildSystemPrompt(env, [
      { title: 'User instructions (~/.zuse/SYSTEM.md)', content: '始终用中文。' },
    ])
    expect(out).toContain('## User instructions (~/.zuse/SYSTEM.md)')
    expect(out).toContain('始终用中文。')
    expect(out.indexOf('Environment:')).toBeLessThan(out.indexOf('## User instructions'))
  })

  it('不传 sections 时输出与原行为完全一致(向后兼容)', () => {
    expect(buildSystemPrompt(env)).toBe(buildSystemPrompt(env, []))
    expect(buildSystemPrompt(env)).not.toContain('##')
  })
})
