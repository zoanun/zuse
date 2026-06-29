import { mkdir, writeFile, rename, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Disabled-skill persistence (M3): a single JSON file of skill names the user has turned off.
 * Kept separate from each SKILL.md so disabling never mutates skill content (and a project skill's
 * file stays clean in git). Mirrors personaStore's atomic write + tolerant load.
 *
 * Filtering happens in createSession (the per-session scan drops disabled names), so a toggle takes
 * effect on the next new chat — same constraint MCP lives with (an open chat's tool set is fixed).
 */

export function skillsDisabledFile(home: string = homedir()): string {
  return join(home, '.zuse', 'skills-disabled.json')
}

interface DisabledFile {
  disabled: string[]
}

function parseDisabled(raw: string): Set<string> {
  const parsed = JSON.parse(raw) as Partial<DisabledFile>
  if (!Array.isArray(parsed.disabled)) return new Set()
  return new Set(parsed.disabled.filter((n): n is string => typeof n === 'string'))
}

/** Load the disabled-name set. Returns an empty set if the file is missing or unparseable. */
export async function loadDisabledSkills(file: string = skillsDisabledFile()): Promise<Set<string>> {
  try {
    return parseDisabled(await readFile(file, 'utf8'))
  } catch {
    return new Set()
  }
}

/** Sync variant for createSession (which builds the registry synchronously). */
export function loadDisabledSkillsSync(file: string = skillsDisabledFile()): Set<string> {
  try {
    return parseDisabled(readFileSync(file, 'utf8'))
  } catch {
    return new Set()
  }
}

/** Atomically persist the disabled-name set (tmp file + rename), sorted for a stable diff. */
export async function saveDisabledSkills(names: Set<string>, file: string = skillsDisabledFile()): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  const data: DisabledFile = { disabled: [...names].sort() }
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}
