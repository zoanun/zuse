import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryItem } from '@zuse/protocol'
import { listMemory, createMemory, updateMemory, deleteMemory } from '../state/manageApi.js'
import type { CreateMemoryBody, UpdateMemoryBody } from '../state/manageApi.js'
import { MemoryPanel, useDebounced } from './MemoryPanel.js'

export type ManagePanel = 'memory' | 'prompts' | 'skills' | 'mcp' | 'usage'

interface NavEntry { id: ManagePanel; label: string; enabled: boolean }
const NAV: NavEntry[] = [
  { id: 'memory', label: 'Memory', enabled: true },
  { id: 'prompts', label: 'Prompts', enabled: false },
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

  const onCreate = useCallback((body: CreateMemoryBody) => {
    createMemory(body).then(refetch).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refetch])
  const onUpdate = useCallback((id: number, body: UpdateMemoryBody) => {
    updateMemory(id, body).then(refetch).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refetch])
  const onDelete = useCallback((id: number) => {
    deleteMemory(id).then(refetch).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [refetch])

  return { items, loading, error, query, setQuery, onCreate, onUpdate, onDelete }
}

function MemoryContainer({ active }: { active: boolean }) {
  const mem = useMemoryData(active)
  const [projectFilter, setProjectFilter] = useState('')
  return (
    <MemoryPanel
      items={mem.items}
      loading={mem.loading}
      error={mem.error}
      query={mem.query}
      onQueryChange={mem.setQuery}
      projectFilter={projectFilter}
      onProjectFilterChange={setProjectFilter}
      onCreate={mem.onCreate}
      onUpdate={mem.onUpdate}
      onDelete={mem.onDelete}
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
              : <div className="mem-empty">Coming soon.</div>}
          </div>
        </div>
      </aside>
    </div>
  )
}
