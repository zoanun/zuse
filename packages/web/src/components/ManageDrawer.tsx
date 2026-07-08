import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@zuse/protocol'
import { listMemory, createMemory, updateMemory, deleteMemory, listProjects } from '../state/manageApi.js'
import { listPersonas, createPersona, updatePersona, deletePersona, activatePersona } from '../state/manageApi.js'
import { listSkills, updateSkill } from '../state/manageApi.js'
import { getUsage } from '../state/manageApi.js'
import { listDir, readFilePreview, writeFile, deleteFile, rawFileUrl, searchFiles } from '../state/manageApi.js'
import { listMcp, addMcp, deleteMcp, reconnectMcp, reconnectMcpServer } from '../state/manageApi.js'
import { ConfirmDialog } from './ConfirmDialog.js'
import type { CreateMemoryBody, UpdateMemoryBody, AddMcpBody } from '../state/manageApi.js'
import { MemoryPanel, useDebounced } from './MemoryPanel.js'
import { PersonasPanel } from './PersonasPanel.js'
import { SkillsPanel } from './SkillsPanel.js'
import { UsagePanel } from './UsagePanel.js'
import { FilesPanel } from './FilesPanel.js'
import { McpPanel } from './McpPanel.js'

export type ManagePanel = 'memory' | 'prompts' | 'skills' | 'mcp' | 'usage' | 'files'

interface NavEntry { id: ManagePanel; label: string; enabled: boolean }
const NAV: NavEntry[] = [
  { id: 'memory', label: '记忆', enabled: true },
  { id: 'prompts', label: '人设', enabled: true },
  { id: 'skills', label: '技能', enabled: true },
  { id: 'mcp', label: 'MCP', enabled: true },
  { id: 'usage', label: '用量', enabled: true },
  { id: 'files', label: '文件', enabled: true },
]

interface Props {
  open: boolean
  activePanel: ManagePanel
  onClose: () => void
  onSelectPanel: (p: ManagePanel) => void
  /** The active session's cwd — the Files browser is rooted here (S3). */
  cwd?: string
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

/** Owns the skills fetch+state lifecycle. */
function useSkillData(active: boolean) {
  const { data, loading, error, mutate } = useResource(active, listSkills)
  return {
    skills: data?.skills ?? [], loading, error,
    onUpdate: useCallback((name: string, b: { description?: string; body?: string; enabled?: boolean }) => mutate(updateSkill(name, b)), [mutate]),
  }
}

function SkillsContainer({ active }: { active: boolean }) {
  const s = useSkillData(active)
  return <SkillsPanel skills={s.skills} loading={s.loading} error={s.error} onUpdate={s.onUpdate} />
}

function UsageContainer({ active }: { active: boolean }) {
  const { data, loading, error } = useResource(active, getUsage)
  return <UsagePanel stats={data} loading={loading} error={error} />
}

function FilesContainer({ active, cwd, dirtyRef }: { active: boolean; cwd?: string; dirtyRef: React.RefObject<boolean> }) {
  // Bind the active session's cwd into the loaders; key by cwd so switching sessions remounts
  // the tree (fresh fetch of the new root) instead of showing the old project's files.
  return (
    <FilesPanel
      key={cwd ?? ''}
      active={active}
      loadDir={(dir) => listDir(dir, cwd)}
      loadFile={(path) => readFilePreview(path, cwd)}
      writeFile={(path, content, opts) => writeFile(path, content, cwd, opts)}
      deleteFile={(path) => deleteFile(path, cwd)}
      rawUrl={(path) => rawFileUrl(path, cwd)}
      searchFiles={(q) => searchFiles(q, cwd)}
      dirtyRef={dirtyRef}
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

/** Drawer width bounds: never narrower than a usable panel, never the whole screen. */
const DRAWER_MIN_W = 480
const DRAWER_DEFAULT_W = 760

export function ManageDrawer({ open, activePanel, onClose, onSelectPanel, cwd }: Props) {
  // The Files editor's unsaved state, mirrored up so tab-switch/close can be guarded — leaving
  // would silently unmount the editor and drop the edits. When dirty, the action is parked in
  // `pendingLeave` and a styled confirm decides whether to run it.
  const filesDirtyRef = useRef(false)
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const guardLeave = useCallback((action: () => void) => {
    if (filesDirtyRef.current) setPendingLeave(() => action)
    else action()
  }, [])

  // Close on Escape while open (an open discard dialog consumes the Esc instead).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (pendingLeave) { setPendingLeave(null); return }
      guardLeave(onClose)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, pendingLeave, guardLeave])

  // Drag the left edge to resize; the chosen width persists across sessions.
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('zuse-drawer-w'))
    return Number.isFinite(saved) && saved >= DRAWER_MIN_W ? saved : DRAWER_DEFAULT_W
  })
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    const onMove = (ev: PointerEvent) => {
      setWidth(Math.min(Math.max(window.innerWidth - ev.clientX, DRAWER_MIN_W), Math.round(window.innerWidth * 0.95)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setWidth((w) => { try { localStorage.setItem('zuse-drawer-w', String(Math.round(w))) } catch { /* ignore */ } return w })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className={'manage-root' + (open ? ' open' : '')} aria-hidden={!open}>
      <div className="manage-backdrop" onClick={() => guardLeave(onClose)} />
      <aside className="manage-drawer" role="dialog" aria-label="管理" aria-modal="true" style={{ width }}>
        <div className="manage-resizer" aria-label="拖拽调整宽度" onPointerDown={onResizeStart} />
        <div className="manage-head">
          <span className="manage-title">管理</span>
          <button className="icon-btn" aria-label="关闭" onClick={() => guardLeave(onClose)}>×</button>
        </div>
        <div className="manage-body">
          <nav className="manage-nav">
            {NAV.map((n) => (
              <button
                key={n.id}
                className={'manage-nav-item' + (n.id === activePanel ? ' active' : '')}
                disabled={!n.enabled}
                onClick={() => n.enabled && n.id !== activePanel && guardLeave(() => onSelectPanel(n.id))}
              >
                {n.label}{!n.enabled ? <span className="manage-soon">即将</span> : null}
              </button>
            ))}
          </nav>
          <div className="manage-panel">
            {activePanel === 'memory'
              ? <MemoryContainer active={open && activePanel === 'memory'} />
              : activePanel === 'prompts'
              ? <PersonasContainer active={open && activePanel === 'prompts'} />
              : activePanel === 'skills'
              ? <SkillsContainer active={open && activePanel === 'skills'} />
              : activePanel === 'mcp'
              ? <McpContainer active={open && activePanel === 'mcp'} />
              : activePanel === 'usage'
              ? <UsageContainer active={open && activePanel === 'usage'} />
              : activePanel === 'files'
              ? <FilesContainer active={open && activePanel === 'files'} cwd={cwd} dirtyRef={filesDirtyRef} />
              : <div className="mem-empty">敬请期待</div>}
          </div>
        </div>
      </aside>
      <ConfirmDialog
        open={pendingLeave !== null}
        message="有未保存的修改，放弃并离开？"
        onConfirm={() => { filesDirtyRef.current = false; pendingLeave?.(); setPendingLeave(null) }}
        onCancel={() => setPendingLeave(null)}
      />
    </div>
  )
}
