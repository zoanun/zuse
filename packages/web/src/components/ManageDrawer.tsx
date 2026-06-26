import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryItem, ProjectInfo, PersonaItem } from '@zuse/protocol'
import { listMemory, createMemory, updateMemory, deleteMemory, listProjects } from '../state/manageApi.js'
import { listPersonas, createPersona, updatePersona, deletePersona, activatePersona } from '../state/manageApi.js'
import type { CreateMemoryBody, UpdateMemoryBody } from '../state/manageApi.js'
import { MemoryPanel, useDebounced } from './MemoryPanel.js'
import { PersonasPanel } from './PersonasPanel.js'

export type ManagePanel = 'memory' | 'prompts' | 'skills' | 'mcp' | 'usage'

interface NavEntry { id: ManagePanel; label: string; enabled: boolean }
const NAV: NavEntry[] = [
  { id: 'memory', label: 'Memory', enabled: true },
  { id: 'prompts', label: 'Personas', enabled: true },
  { id: 'skills', label: 'Skills', enabled: false },
  { id: 'mcp', label: 'MCP', enabled: false },
  { id: 'usage', label: 'Usage', enabled: false },
]

interface Props {
  open: boolean
  activePanel: ManagePanel
  onClose: () => void
  onSelectPanel: (p: ManagePanel) => void
}

/** Owns the Memory fetch+state lifecycle: load on open, refetch after mutations. */
function useMemoryData(active: boolean) {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 250)
  // Bumped to force a refetch after a mutation.
  const [reloadTick, setReloadTick] = useState(0)
  const reqSeq = useRef(0)

  useEffect(() => {
    if (!active) return
    const seq = ++reqSeq.current
    setLoading(true)
    setError(null)
    const q = debouncedQuery.trim()
    listMemory(q ? { q } : {})
      .then((rows) => { if (seq === reqSeq.current) { setItems(rows); setLoading(false) } })
      .catch((e: unknown) => { if (seq === reqSeq.current) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) } })
  }, [active, debouncedQuery, reloadTick])

  const refetch = useCallback(() => setReloadTick((n) => n + 1), [])
  // Every mutation does the same thing: run it, refetch on success, surface the error on failure.
  const mutate = useCallback((p: Promise<unknown>) => {
    p.then(refetch).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refetch])

  const onCreate = useCallback((body: CreateMemoryBody) => mutate(createMemory(body)), [mutate])
  const onUpdate = useCallback((id: number, body: UpdateMemoryBody) => mutate(updateMemory(id, body)), [mutate])
  const onDelete = useCallback((id: number) => mutate(deleteMemory(id)), [mutate])

  return { items, loading, error, query, setQuery, onCreate, onUpdate, onDelete }
}

function MemoryContainer({ active }: { active: boolean }) {
  const mem = useMemoryData(active)
  const [projectFilter, setProjectFilter] = useState('')
  // Known {slug, cwd} so the project picker shows real directory names, not the slug.
  const [projectInfos, setProjectInfos] = useState<ProjectInfo[]>([])
  useEffect(() => {
    if (!active) return
    listProjects().then(setProjectInfos).catch(() => { /* labels just fall back to the slug */ })
  }, [active])
  return (
    <MemoryPanel
      items={mem.items}
      loading={mem.loading}
      error={mem.error}
      query={mem.query}
      onQueryChange={mem.setQuery}
      projectFilter={projectFilter}
      onProjectFilterChange={setProjectFilter}
      projectInfos={projectInfos}
      onCreate={mem.onCreate}
      onUpdate={mem.onUpdate}
      onDelete={mem.onDelete}
    />
  )
}

/** Owns the persona fetch+state lifecycle: load on open, refetch after mutations. */
function usePersonaData(active: boolean) {
  const [personas, setPersonas] = useState<PersonaItem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const reqSeq = useRef(0)

  useEffect(() => {
    if (!active) return
    const seq = ++reqSeq.current
    setLoading(true)
    setError(null)
    listPersonas()
      .then((s) => { if (seq === reqSeq.current) { setPersonas(s.personas); setActiveId(s.activeId); setLoading(false) } })
      .catch((e: unknown) => { if (seq === reqSeq.current) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) } })
  }, [active, reloadTick])

  const refetch = useCallback(() => setReloadTick((n) => n + 1), [])
  const mutate = useCallback((p: Promise<unknown>) => {
    p.then(refetch).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refetch])

  return {
    personas, activeId, loading, error,
    onCreate: useCallback((b: { name: string; content: string }) => mutate(createPersona(b)), [mutate]),
    onUpdate: useCallback((id: string, b: { name?: string; content?: string }) => mutate(updatePersona(id, b)), [mutate]),
    onDelete: useCallback((id: string) => mutate(deletePersona(id)), [mutate]),
    onActivate: useCallback((id: string | null) => mutate(activatePersona(id)), [mutate]),
  }
}

function PersonasContainer({ active }: { active: boolean }) {
  const p = usePersonaData(active)
  return (
    <PersonasPanel
      personas={p.personas}
      activeId={p.activeId}
      loading={p.loading}
      error={p.error}
      onCreate={p.onCreate}
      onUpdate={p.onUpdate}
      onDelete={p.onDelete}
      onActivate={p.onActivate}
    />
  )
}

export function ManageDrawer({ open, activePanel, onClose, onSelectPanel }: Props) {
  // Close on Escape while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <div className={'manage-root' + (open ? ' open' : '')} aria-hidden={!open}>
      <div className="manage-backdrop" onClick={onClose} />
      <aside className="manage-drawer" role="dialog" aria-label="Manage" aria-modal="true">
        <div className="manage-head">
          <span className="manage-title">Manage</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="manage-body">
          <nav className="manage-nav">
            {NAV.map((n) => (
              <button
                key={n.id}
                className={'manage-nav-item' + (n.id === activePanel ? ' active' : '')}
                disabled={!n.enabled}
                onClick={() => n.enabled && onSelectPanel(n.id)}
              >
                {n.label}{!n.enabled ? <span className="manage-soon">soon</span> : null}
              </button>
            ))}
          </nav>
          <div className="manage-panel">
            {activePanel === 'memory'
              ? <MemoryContainer active={open && activePanel === 'memory'} />
              : activePanel === 'prompts'
              ? <PersonasContainer active={open && activePanel === 'prompts'} />
              : <div className="mem-empty">Coming soon.</div>}
          </div>
        </div>
      </aside>
    </div>
  )
}
