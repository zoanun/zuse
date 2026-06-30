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
        <span className="mem-field-label">名称</span>
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 Reviewer" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">内容 <span className="mem-opt">(叠加在只读的核心提示词之上)</span></span>
        <textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="人设指令（markdown）…" />
      </label>
      <div className="mem-form-actions">
        <button type="submit" disabled={!valid}>{initial ? '保存' : '新增'}</button>
        <button type="button" className="ghost" onClick={onCancel}>取消</button>
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
        title={active ? '已启用 —— 点击停用' : '启用此人设'}
        aria-label={active ? '停用人设' : '启用人设'}
        aria-pressed={active}
        onClick={() => onActivate(active ? null : item.id)}
      />
      <span className="mem-label" title={item.content}>{item.name}</span>
      {confirming ? (
        <span className="mem-confirm">
          <button className="mem-confirm-yes" title="确认删除" aria-label="确认删除" onClick={() => { setConfirming(false); onDelete(item.id) }}>✓</button>
          <button className="mem-confirm-no" title="取消" aria-label="取消删除" onClick={() => setConfirming(false)}>✕</button>
        </span>
      ) : (
        <span className="mem-actions">
          <button className="mem-edit" title="编辑" aria-label="编辑人设" onClick={onEdit}>✎</button>
          <button className="mem-del" title="删除" aria-label="删除人设" onClick={() => setConfirming(true)}>×</button>
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
        <div className="persona-hint">启用一个人设 —— 它会叠加在只读的核心提示词之上。在新对话中生效。</div>
        <button className="mem-new" onClick={() => setEditing((e) => (e === 'new' ? null : 'new'))}>＋ 新增</button>
      </div>

      {editing === 'new' ? (
        <PersonaForm onSubmit={(d) => { onCreate(d); setEditing(null) }} onCancel={() => setEditing(null)} />
      ) : null}

      {error ? <div className="mem-error">{error}</div> : null}
      {loading ? <div className="mem-empty">加载中…</div> : null}
      {!loading && personas.length === 0 && !error ? <div className="mem-empty">暂无人设。</div> : null}

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
