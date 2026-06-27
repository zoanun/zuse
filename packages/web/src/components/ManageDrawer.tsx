import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@zuse/protocol'
import { listMemory, createMemory, updateMemory, deleteMemory, listProjects } from '../state/manageApi.js'
import { listPersonas, createPersona, updatePersona, deletePersona, activatePersona } from '../state/manageApi.js'
import { listMcp, addMcp, deleteMcp, reconnectMcp, reconnectMcpServer } from '../state/manageApi.js'
import type { CreateMemoryBody, UpdateMemoryBody, AddMcpBody } from '../state/manageApi.js'
import { MemoryPanel, useDebounced } from './MemoryPanel.js'
import { PersonasPanel } from './PersonasPanel.js'
import { McpPanel } from './McpPanel.js'

export type ManagePanel = 'memory' | 'prompts' | 'skills' | 'mcp' | 'usage'

interface NavEntry { id: ManagePanel; label: string; enabled: boolean }
const NAV: NavEntry[] = [
  { id: 'memory', label: 'Memory', enabled: true },
  { id: 'prompts', label: 'Personas', enabled: true },
  { id: 'skills', label: 'Skills', enabled: false },
  { id: 'mcp', label: 'MCP', enabled: true },
  { id: 'usage', label: 'Usage', enabled: false },
]

interface Props {
  open: boolean
  activePanel: ManagePanel
  onClose: () => void
  onSelectPanel: (p: ManagePanel) => void
}

/**
 * Generic "load on open, refetch after mutation" resource hook shared by the manage panels:
 * fetches when `active` (and on any `deps` change), guards stale responses with a request seq,
 * and exposes mutate() = run a promise → refetch on success, surface its error on failure.
 */
function useResource<T>(active: boolean, fetchFn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const reqSeq = useRef(0)

  useEffect(() => {
    if (!active) return
    const seq = ++reqSeq.current
    setLoading(true)
    setError(null)
    fetchFn()
      .then((d) => { if (seq === reqSeq.current) { setData(d); setLoading(false) } })
      .catch((e: unknown) => { if (seq === reqSeq.current) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) } })
    // fetchFn is recreated each render but only read here at run time; the caller lists what
    // should actually trigger a refetch in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reloadTick, ...deps])

  const refetch = useCallback(() => setReloadTick((n) => n + 1), [])
  const mutate = useCallback((p: Promise<unknown>) => {
    p.then(refetch).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refetch])

  return { data, loading, error, mutate }
}

/** Owns the Memory fetch+state lifecycle (search query drives the fetch). */
function useMemoryData(active: boolean) {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 250)
  const { data, loading, error, mutate } = useResource(
    active,
    () => { const q = debouncedQuery.trim(); return listMemory(q ? { q } : {}) },
    [debouncedQuery],
  )
  return {
    items: data ?? [], loading, error, query, setQuery,
    onCreate: useCallback((body: CreateMemoryBody) => mutate(createMemory(body)), [mutate]),
    onUpdate: useCallback((id: number, body: UpdateMemoryBody) => mutate(updateMemory(id, body)), [mutate]),
    onDelete: useCallback((id: number) => mutate(deleteMemory(id)), [mutate]),
  }
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

/** Owns the persona fetch+state lifecycle. */
function usePersonaData(active: boolean) {
  const { data, loading, error, mutate } = useResource(active, listPersonas)
  return {
    personas: data?.personas ?? [], activeId: data?.activeId ?? null, loading, error,
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

/** Owns the MCP fetch+state lifecycle. */
function useMcpData(active: boolean) {
  const { data, loading, error, mutate } = useResource(active, listMcp)
  return {
    servers: data ?? [], loading, error,
    onAdd: useCallback((b: AddMcpBody) => mutate(addMcp(b)), [mutate]),
    onDelete: useCallback((name: string) => mutate(deleteMcp(name)), [mutate]),
    onReconnect: useCallback(() => mutate(reconnectMcp()), [mutate]),
    onReconnectServer: useCallback((name: string) => mutate(reconnectMcpServer(name)), [mutate]),
  }
}

function McpContainer({ active }: { active: boolean }) {
  const m = useMcpData(active)
  return <McpPanel servers={m.servers} loading={m.loading} error={m.error} onAdd={m.onAdd} onDelete={m.onDelete} onReconnect={m.onReconnect} onReconnectServer={m.onReconnectServer} />
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
              : activePanel === 'mcp'
              ? <McpContainer active={open && activePanel === 'mcp'} />
              : <div className="mem-empty">Coming soon.</div>}
          </div>
        </div>
      </aside>
    </div>
  )
}
