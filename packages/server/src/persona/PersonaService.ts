import type { PersonaItem, PersonasState } from '@zuse/protocol'
import { loadPersonas, savePersonas, personasFile } from './personaStore.js'

/** Time-sortable persona id: p-<base36 time>-<4 hex>. */
function newPersonaId(): string {
  return `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`
}

/**
 * CRUD + activation over the persona store (M2). One persona may be active; its content is
 * layered onto the read-only core prompt at session build (see createSession). Each mutation
 * reads-modifies-writes the single JSON file — fine for a single-user local daemon.
 */
export class PersonaService {
  constructor(private readonly file: string = personasFile()) {}

  list(): Promise<PersonasState> {
    return loadPersonas(this.file)
  }

  async getActive(): Promise<PersonaItem | null> {
    const { personas, activeId } = await loadPersonas(this.file)
    return personas.find((p) => p.id === activeId) ?? null
  }

  async create(fields: { name: string; content: string }): Promise<PersonaItem> {
    const state = await loadPersonas(this.file)
    const now = new Date().toISOString()
    const persona: PersonaItem = {
      id: newPersonaId(), name: fields.name, content: fields.content, createdAt: now, updatedAt: now,
    }
    state.personas.push(persona)
    await savePersonas(state, this.file)
    return persona
  }

  async update(id: string, fields: { name?: string; content?: string }): Promise<PersonaItem | null> {
    const state = await loadPersonas(this.file)
    const p = state.personas.find((x) => x.id === id)
    if (!p) return null
    if (fields.name !== undefined) p.name = fields.name
    if (fields.content !== undefined) p.content = fields.content
    p.updatedAt = new Date().toISOString()
    await savePersonas(state, this.file)
    return p
  }

  async remove(id: string): Promise<boolean> {
    const state = await loadPersonas(this.file)
    const before = state.personas.length
    state.personas = state.personas.filter((p) => p.id !== id)
    if (state.personas.length === before) return false
    if (state.activeId === id) state.activeId = null // removing the active one clears activation
    await savePersonas(state, this.file)
    return true
  }

  /** Activate a persona (or clear with null). Returns false if the id doesn't exist. */
  async activate(id: string | null): Promise<boolean> {
    const state = await loadPersonas(this.file)
    if (id !== null && !state.personas.some((p) => p.id === id)) return false
    state.activeId = id
    await savePersonas(state, this.file)
    return true
  }
}
