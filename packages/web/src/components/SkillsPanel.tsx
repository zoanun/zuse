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
        <span className="mem-field-label">描述 <span className="mem-opt">(模型的触发依据)</span></span>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="模型应在什么情况下使用此技能？" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">正文 <span className="mem-opt">(SKILL.md 指令)</span></span>
        <textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} placeholder="技能指令（markdown）…" />
      </label>
      <div className="mem-form-actions">
        <button type="submit" disabled={!valid}>保存</button>
        <button type="button" className="ghost" onClick={onCancel}>取消</button>
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
        title={item.enabled ? '已启用 —— 点击禁用（新对话生效）' : '已禁用 —— 点击启用（新对话生效）'}
        aria-label={item.enabled ? '禁用技能' : '启用技能'}
        aria-pressed={item.enabled}
        onClick={() => onSetEnabled(!item.enabled)}
      />
      <span className="mem-label skill-name" title="点击查看" onClick={onToggleExpand}>{item.name}</span>
      <span className={'skill-src skill-src-' + item.source}>{item.source}</span>
      <span className="mem-actions">
        {/* Builtin skills are compiled into zuse — no SKILL.md to rewrite, so no edit affordance. */}
        {item.source !== 'builtin' ? (
          <button className="mem-edit" title="编辑" aria-label="编辑技能" onClick={onEdit}>✎</button>
        ) : null}
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
        <div className="persona-hint">编辑技能的描述/正文，或将其关闭。正文修改会在模型下次打开该技能时加载；启用/禁用在新对话中生效。内置技能（builtin）随 zuse 编译发布，只能启停、不可编辑——要改就在 ~/.zuse/skills/ 下建同名技能覆盖它。</div>
      </div>

      {error ? <div className="mem-error">{error}</div> : null}
      {loading ? <div className="mem-empty">加载中…</div> : null}
      {!loading && skills.length === 0 && !error ? <div className="mem-empty">未找到技能。</div> : null}

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
