import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillService } from './SkillService.js'

/** Write a <root>/.zuse/skills/<name>/SKILL.md with the given frontmatter description + body. */
function writeSkill(root: string, name: string, description: string, body: string, extraFront = ''): void {
  const dir = join(root, '.zuse', 'skills', name)
  mkdirSync(dir, { recursive: true })
  const front = `name: ${name}\ndescription: ${description}${extraFront ? '\n' + extraFront : ''}`
  writeFileSync(join(dir, 'SKILL.md'), `---\n${front}\n---\n\n${body}\n`, 'utf8')
}

// Unique fixture names so they never collide with (or get overridden by) the developer's real
// ~/.zuse/skills: scanSkills also walks the cwd ancestor chain, which on Windows runs through the
// real user home (the same environment leak behind the known pre-existing skills.test failures).
// We therefore assert on our fixtures by name rather than on the full list / counts.
const USER_SKILL = 'zz-m3-user-skill'
const PROJ_SKILL = 'zz-m3-proj-skill'

describe('SkillService (M3)', () => {
  let home: string, proj: string, svc: SkillService, disabledFile: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zuse-skill-home-'))
    proj = mkdtempSync(join(tmpdir(), 'zuse-skill-proj-'))
    disabledFile = join(home, 'skills-disabled.json')
    writeSkill(home, USER_SKILL, 'use when planning', 'User body here.')
    writeSkill(proj, PROJ_SKILL, 'use when shipping', 'Proj body here.')
    svc = new SkillService({ home, cwd: proj, disabledFile })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  })

  it('lists skills with source (user/project) and enabled=true by default', async () => {
    const { skills } = await svc.list()
    const user = skills.find((s) => s.name === USER_SKILL)!
    const projSkill = skills.find((s) => s.name === PROJ_SKILL)!
    expect(user.source).toBe('user')
    expect(projSkill.source).toBe('project')
    expect(user.description).toBe('use when planning')
    expect(projSkill.body.trim()).toBe('Proj body here.')
    expect(user.enabled).toBe(true)
    expect(projSkill.enabled).toBe(true)
  })

  it('update rewrites the SKILL.md description and body on disk', async () => {
    const updated = await svc.update(USER_SKILL, { description: 'NEW desc', body: 'NEW body' })
    expect(updated?.description).toBe('NEW desc')
    expect(updated?.body.trim()).toBe('NEW body')
    // Re-read raw to prove it hit disk and re-parses.
    const raw = readFileSync(join(home, '.zuse', 'skills', USER_SKILL, 'SKILL.md'), 'utf8')
    expect(raw).toContain('description: NEW desc')
    expect(raw).toContain('NEW body')
    const { skills } = await svc.list()
    expect(skills.find((s) => s.name === USER_SKILL)?.description).toBe('NEW desc')
  })

  it('update preserves the name and any unknown frontmatter keys', async () => {
    const tagged = 'zz-m3-tagged'
    writeSkill(home, tagged, 'orig', 'orig body', 'version: 2\nauthor: me')
    const svc2 = new SkillService({ home, cwd: proj, disabledFile })
    await svc2.update(tagged, { description: 'changed' })
    const raw = readFileSync(join(home, '.zuse', 'skills', tagged, 'SKILL.md'), 'utf8')
    expect(raw).toContain(`name: ${tagged}`)
    expect(raw).toContain('description: changed')
    expect(raw).toContain('version: 2')
    expect(raw).toContain('author: me')
  })

  it('disable adds to the disabled file and flips enabled; enable removes it', async () => {
    const off = await svc.update(PROJ_SKILL, { enabled: false })
    expect(off?.enabled).toBe(false)
    expect(JSON.parse(readFileSync(disabledFile, 'utf8')).disabled).toContain(PROJ_SKILL)
    // The next list still shows it (panel lists all), just disabled.
    expect((await svc.list()).skills.find((s) => s.name === PROJ_SKILL)?.enabled).toBe(false)

    const on = await svc.update(PROJ_SKILL, { enabled: true })
    expect(on?.enabled).toBe(true)
    expect(JSON.parse(readFileSync(disabledFile, 'utf8')).disabled).not.toContain(PROJ_SKILL)
  })

  it('returns null for an unknown skill name', async () => {
    expect(await svc.update('zz-m3-nope', { description: 'x' })).toBeNull()
  })
})
