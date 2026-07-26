import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { scanSkills } from '@zuse/tools'
import type { SkillItem, SkillsState } from '@zuse/protocol'
import { loadDisabledSkills, saveDisabledSkills, skillsDisabledFile } from './skillStore.js'

interface SkillServiceDeps {
  home?: string
  cwd: string
  disabledFile?: string
}

/**
 * Skill management (M3): list / view / edit / enable-disable the skills the `Skill` tool exposes.
 * No create/delete (the roadmap scopes M3 to managing existing skills). Each call re-scans disk, so
 * the panel is always fresh; edits rewrite the skill's SKILL.md in place; enable/disable toggles a
 * names set in skills-disabled.json (never touching SKILL.md content).
 */
export class SkillService {
  private readonly home: string
  private readonly cwd: string
  private readonly disabledFile: string

  constructor(deps: SkillServiceDeps) {
    this.home = deps.home ?? homedir()
    this.cwd = deps.cwd
    this.disabledFile = deps.disabledFile ?? skillsDisabledFile(this.home)
  }

  /** All loaded skills, marked with source (user/project/builtin) and enabled state. */
  async list(): Promise<SkillsState> {
    const disabled = await loadDisabledSkills(this.disabledFile)
    const userRoot = resolve(join(this.home, '.zuse', 'skills'))
    const skills: SkillItem[] = scanSkills(this.home, this.cwd).map((s) => ({
      name: s.name,
      description: s.description,
      body: s.body,
      // Builtin skills carry dir:'' and resolve('') is the process cwd — without the explicit
      // builtin check they'd be mislabeled 'project'.
      source: s.builtin ? 'builtin' : resolve(s.dir).startsWith(userRoot) ? 'user' : 'project',
      enabled: !disabled.has(s.name),
    }))
    // Stable, human-friendly order: by name.
    skills.sort((a, b) => a.name.localeCompare(b.name))
    return { skills }
  }

  /**
   * Apply changes to one skill. `enabled` toggles the disabled-list; `description`/`body` rewrite
   * its SKILL.md. Returns the updated SkillItem, or null if no skill by that name is loaded.
   */
  async update(
    name: string,
    fields: { description?: string; body?: string; enabled?: boolean },
  ): Promise<SkillItem | null> {
    const entry = scanSkills(this.home, this.cwd).find((s) => s.name === name)
    if (!entry) return null

    // Builtin skills have no file on disk: description/body are not editable (to change one, create
    // a same-named skill under ~/.zuse/skills/, which overrides the builtin wholesale). `enabled`
    // still toggles — the disabled list is keyed by name, so it applies to builtins too.
    if (entry.builtin && (fields.description !== undefined || fields.body !== undefined)) {
      throw new Error(
        `Cannot edit builtin skill "${name}": create a same-named skill under ~/.zuse/skills/ to override it.`,
      )
    }

    if (fields.description !== undefined || fields.body !== undefined) {
      await rewriteSkillFile(join(entry.dir, 'SKILL.md'), {
        description: fields.description,
        body: fields.body,
      })
    }

    if (fields.enabled !== undefined) {
      const disabled = await loadDisabledSkills(this.disabledFile)
      if (fields.enabled) disabled.delete(name)
      else disabled.add(name)
      await saveDisabledSkills(disabled, this.disabledFile)
    }

    // Re-read so the returned item reflects what's now on disk.
    const state = await this.list()
    return state.skills.find((s) => s.name === name) ?? null
  }
}

/**
 * Rewrite a SKILL.md, preserving its frontmatter ordering and any unknown keys: only the
 * `description` line is swapped (when given) and the body replaced (when given). A file with no
 * frontmatter gets a minimal one synthesized so the edited description still parses next scan.
 */
async function rewriteSkillFile(
  file: string,
  fields: { description?: string; body?: string },
): Promise<void> {
  const raw = await readFile(file, 'utf8')
  const { frontLines, body: oldBody } = splitFrontmatter(raw)
  const lines = [...frontLines]

  if (fields.description !== undefined) {
    const oneLine = fields.description.replace(/\r?\n/g, ' ').trim()
    const idx = lines.findIndex((l) => /^description\s*:/.test(l))
    if (idx === -1) lines.push(`description: ${oneLine}`)
    else lines[idx] = `description: ${oneLine}`
  }

  const body = fields.body !== undefined ? fields.body : oldBody
  const out = `---\n${lines.join('\n')}\n---\n\n${body.replace(/\s+$/, '')}\n`

  const tmp = `${file}.tmp`
  await writeFile(tmp, out, 'utf8')
  await rename(tmp, file)
}

/** Split into frontmatter lines (between the --- fences) and the body. No fence → empty front. */
function splitFrontmatter(raw: string): { frontLines: string[]; body: string } {
  if (!raw.startsWith('---')) return { frontLines: [], body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { frontLines: [], body: raw }
  const front = raw.slice(3, end).replace(/^\r?\n/, '')
  const body = raw.slice(end + 4).replace(/^[\r\n]+/, '')
  return { frontLines: front.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0), body }
}
