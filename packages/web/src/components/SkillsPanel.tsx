import { Fragment, useState } from 'react'
import type { SkillItem } from '@zuse/protocol'

interface Props {
  skills: SkillItem[]
  loading?: boolean
  error?: string | null
  /** Edit description/body, or toggle enabled. */
  onUpdate: (name: string, body: { description?: string; body?: string; enabled?: boolean }) => void
}

function SkillForm({ initial, onSubmit, onCancel }: {
  initial: SkillItem
  onSubmit: (d: { description: string; body: string }) => void
  onCancel: () => void
}) {
  const [description, setDescription] = useState(initial.description)
  const [body, setBody] = useState(initial.body)
  const valid = description.trim() !== '' && body.trim() !== ''
  return (
    <form className="mem-form" onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit({ description: description.trim(), body }) }}>
      <label className="mem-field">
        <span className="mem-field-label">Description <span className="mem-opt">(the model's trigger basis)</span></span>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When should the model reach for this skill?" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">Body <span className="mem-opt">(SKILL.md instructions)</span></span>
        <textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Skill instructions (markdown)…" />
      </label>
      <div className="mem-form-actions">
        <button type="submit" disabled={!valid}>Save</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function SkillRow({ item, onToggleExpand, onEdit, onSetEnabled }: {
  item: SkillItem
  onToggleExpand: () => void
  onEdit: () => void
  onSetEnabled: (enabled: boolean) => void
}) {
  return (
    <li className={'mem-item' + (item.enabled ? '' : ' skill-off')}>
      <button
        className={'persona-toggle' + (item.enabled ? ' on' : '')}
        title={item.enabled ? 'Enabled — click to disable (new chats)' : 'Disabled — click to enable (new chats)'}
        aria-label={item.enabled ? 'Disable skill' : 'Enable skill'}
        aria-pressed={item.enabled}
        onClick={() => onSetEnabled(!item.enabled)}
      />
      <span className="mem-label skill-name" title="Click to view" onClick={onToggleExpand}>{item.name}</span>
      <span className={'skill-src skill-src-' + item.source}>{item.source}</span>
      <span className="mem-actions">
        <button className="mem-edit" title="Edit" aria-label="Edit skill" onClick={onEdit}>✎</button>
      </span>
    </li>
  )
}

export function SkillsPanel({ skills, loading, error, onUpdate }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div className="mem-panel">
      <div className="mem-toolbar">
        <div className="persona-hint">Edit a skill's description/body, or toggle it off. Body edits load the next time the model opens the skill; enable/disable applies to new chats.</div>
      </div>

      {error ? <div className="mem-error">{error}</div> : null}
      {loading ? <div className="mem-empty">Loading…</div> : null}
      {!loading && skills.length === 0 && !error ? <div className="mem-empty">No skills found.</div> : null}

      <ul className="mem-list">
        {skills.map((s) => (
          editing === s.name ? (
            <li key={s.name} className="mem-item-editing">
              <SkillForm
                initial={s}
                onSubmit={(d) => { onUpdate(s.name, d); setEditing(null) }}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <Fragment key={s.name}>
              <SkillRow
                item={s}
                onToggleExpand={() => setExpanded((e) => (e === s.name ? null : s.name))}
                onEdit={() => { setEditing(s.name); setExpanded(null) }}
                onSetEnabled={(enabled) => onUpdate(s.name, { enabled })}
              />
              {expanded === s.name ? (
                <li className="skill-view">
                  <div className="skill-view-desc">{s.description}</div>
                  <pre className="skill-view-body">{s.body}</pre>
                </li>
              ) : null}
            </Fragment>
          )
        ))}
      </ul>
    </div>
  )
}
