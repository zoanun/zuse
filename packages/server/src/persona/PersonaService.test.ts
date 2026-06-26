import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonaService } from './PersonaService.js'

describe('PersonaService', () => {
  let dir: string, svc: PersonaService
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zuse-persona-'))
    svc = new PersonaService(join(dir, 'personas.json'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('starts empty', async () => {
    expect(await svc.list()).toEqual({ personas: [], activeId: null })
    expect(await svc.getActive()).toBeNull()
  })

  it('creates, lists, updates, and removes a persona', async () => {
    const p = await svc.create({ name: 'Reviewer', content: 'be terse' })
    expect(p.id).toMatch(/^p-/)
    expect((await svc.list()).personas).toHaveLength(1)

    const updated = await svc.update(p.id, { content: 'be very terse' })
    expect(updated!.content).toBe('be very terse')
    expect(updated!.name).toBe('Reviewer') // unchanged field preserved

    expect(await svc.remove(p.id)).toBe(true)
    expect((await svc.list()).personas).toHaveLength(0)
    expect(await svc.remove(p.id)).toBe(false) // idempotent
  })

  it('update/activate on an unknown id is a no-op / false', async () => {
    expect(await svc.update('nope', { name: 'x' })).toBeNull()
    expect(await svc.activate('nope')).toBe(false)
  })

  it('activates a persona and getActive returns it; null clears', async () => {
    const p = await svc.create({ name: 'A', content: 'aaa' })
    expect(await svc.activate(p.id)).toBe(true)
    expect((await svc.list()).activeId).toBe(p.id)
    expect((await svc.getActive())!.content).toBe('aaa')

    expect(await svc.activate(null)).toBe(true)
    expect(await svc.getActive()).toBeNull()
  })

  it('removing the active persona clears activeId', async () => {
    const p = await svc.create({ name: 'A', content: 'aaa' })
    await svc.activate(p.id)
    await svc.remove(p.id)
    expect((await svc.list()).activeId).toBeNull()
  })

  it('persists across service instances (same file)', async () => {
    const p = await svc.create({ name: 'Persist', content: 'x' })
    await svc.activate(p.id)
    const svc2 = new PersonaService(join(dir, 'personas.json'))
    const state = await svc2.list()
    expect(state.personas).toHaveLength(1)
    expect(state.activeId).toBe(p.id)
  })
})
