import { mkdir, writeFile, rename, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PersonaItem, PersonasState } from '@zuse/protocol'

/**
 * Persona persistence (M2): a single JSON file holding all named personas plus which one is
 * active. Mirrors sessionStore's atomic write (tmp + rename) so a crash mid-write can't leave a
 * corrupt file, and tolerates a missing/corrupt file by returning empty state.
 */

// Always return a FRESH empty state — never a shared constant: callers mutate the result
// (e.g. create() pushes into .personas), so a shared object would accumulate across calls.
const emptyState = (): PersonasState => ({ personas: [], activeId: null })

export function personasFile(home: string = homedir()): string {
  return join(home, '.zuse', 'personas.json')
}

/** Load all personas. Returns a fresh empty state if the file is missing or unparseable. */
export async function loadPersonas(file: string = personasFile()): Promise<PersonasState> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<PersonasState>
    if (!Array.isArray(parsed.personas)) return emptyState()
    const personas = parsed.personas.filter(
      (p): p is PersonasState['personas'][number] =>
        !!p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.content === 'string',
    )
    // Drop a dangling activeId that points at no existing persona.
    const activeId = typeof parsed.activeId === 'string' && personas.some((p) => p.id === parsed.activeId)
      ? parsed.activeId
      : null
    return { personas, activeId }
  } catch {
    return emptyState()
  }
}

/**
 * Synchronously read the active persona — used by createSession (which builds the system prompt
 * synchronously). Returns null if no file / no active persona / unparseable.
 */
export function loadActivePersonaSync(file: string = personasFile()): PersonaItem | null {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as PersonasState
    return state.personas?.find((p) => p.id === state.activeId) ?? null
  } catch {
    return null
  }
}

/** Atomically persist the full persona state (tmp file + rename). */
export async function savePersonas(state: PersonasState, file: string = personasFile()): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, file)
}
