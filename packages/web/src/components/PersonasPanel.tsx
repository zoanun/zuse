import { useState } from 'react'
import type { PersonaItem } from '@zuse/protocol'

interface Props {
  personas: PersonaItem[]
  activeId: string | null
  loading?: boolean
  error?: string | null
  onCreate: (body: { name: string; content: string }) => void
  onUpdate: (id: string, body: { name?: string; content?: string }) => void
  onDelete: (id: string) => void
  /** Activate a persona, or pass null to deactivate (back to core-only prompt). */
  onActivate: (id: string | null) => void
}

function PersonaForm({ initial, onSubmit, onCancel }: {
  initial?: PersonaItem
  onSubmit: (d: { name: string; content: string }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const valid = name.trim() !== '' && content.trim() !== ''
  return (
    <form className="mem-form" onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit({ name: name.trim(), content }) }}>
      <label className="mem-field">
        <span className="mem-field-label">Name</span>
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Reviewer" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">Content <span className="mem-opt">(layered on the read-only core prompt)</span></span>
        <textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Persona instructions (markdown)…" />
      </label>
      <div className="mem-form-actions">
        <button type="submit" disabled={!valid}>{initial ? 'Save' : 'Add'}</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function PersonaRow({ item, active, onActivate, onEdit, onDelete }: {
  item: PersonaItem
  active: boolean
  onActivate: (id: string | null) => void
  onEdit: () => void
  onDelete: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <li className={'mem-item' + (active ? ' persona-active' : '')}>
      <button
        className={'persona-toggle' + (active ? ' on' : '')}
        title={active ? 'Active — click to deactivate' : 'Activate this persona'}
        aria-label={active ? 'Deactivate persona' : 'Activate persona'}
        aria-pressed={active}
        onClick={() => onActivate(active ? null : item.id)}
      >{active ? '●' : '○'}</button>
      <span className="mem-label" title={item.content}>{item.name}</span>
      {confirming ? (
        <span className="mem-confirm">
          <button className="mem-confirm-yes" onClick={() => { setConfirming(false); onDelete(item.id) }}>Delete</button>
          <button className="mem-confirm-no" onClick={() => setConfirming(false)}>Cancel</button>
        </span>
      ) : (
        <span className="mem-actions">
          <button className="mem-edit" title="Edit" aria-label="Edit persona" onClick={onEdit}>✎</button>
          <button className="mem-del" title="Delete" aria-label="Delete persona" onClick={() => setConfirming(true)}>×</button>
        </span>
      )}
    </li>
  )
}

export function PersonasPanel(props: Props) {
  const { personas, activeId, loading, error, onCreate, onUpdate, onDelete, onActivate } = props
  const [editing, setEditing] = useState<'new' | string | null>(null)
  const editingItem = typeof editing === 'string' ? personas.find((p) => p.id === editing) : undefined

  return (
    <div className="mem-panel">
      <div className="mem-toolbar">
        <div className="persona-hint">Activate one persona — it layers on the read-only core prompt. Takes effect on new chats.</div>
        <button className="mem-new" onClick={() => setEditing((e) => (e === 'new' ? null : 'new'))}>＋ New</button>
      </div>

      {editing === 'new' ? (
        <PersonaForm onSubmit={(d) => { onCreate(d); setEditing(null) }} onCancel={() => setEditing(null)} />
      ) : null}

      {error ? <div className="mem-error">{error}</div> : null}
      {loading ? <div className="mem-empty">Loading…</div> : null}
      {!loading && personas.length === 0 && !error ? <div className="mem-empty">No personas yet.</div> : null}

      <ul className="mem-list">
        {personas.map((p) => (
          editingItem && editingItem.id === p.id ? (
            <li key={p.id} className="mem-item-editing">
              <PersonaForm
                initial={p}
                onSubmit={(d) => { onUpdate(p.id, d); setEditing(null) }}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <PersonaRow
              key={p.id}
              item={p}
              active={p.id === activeId}
              onActivate={onActivate}
              onEdit={() => setEditing(p.id)}
              onDelete={onDelete}
            />
          )
        ))}
      </ul>
    </div>
  )
}
