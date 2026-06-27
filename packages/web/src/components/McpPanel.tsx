import { useState } from 'react'
import type { McpServerInfo } from '@zuse/protocol'
import type { AddMcpBody } from '../state/manageApi.js'

interface Props {
  servers: McpServerInfo[]
  loading?: boolean
  error?: string | null
  onAdd: (body: AddMcpBody) => void
  onDelete: (name: string) => void
}

const STATUS_LABEL: Record<McpServerInfo['status'], string> = {
  connected: 'connected', failed: 'failed', configured: 'restart to connect',
}

function AddForm({ onSubmit, onCancel }: { onSubmit: (b: AddMcpBody) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const valid = name.trim() !== '' && command.trim() !== ''
  return (
    <form className="mem-form" onSubmit={(e) => {
      e.preventDefault()
      if (!valid) return
      const argv = args.trim() ? args.trim().split(/\s+/) : undefined
      onSubmit({ name: name.trim(), command: command.trim(), args: argv })
    }}>
      <label className="mem-field">
        <span className="mem-field-label">Name</span>
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. playwright" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">Command</span>
        <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="e.g. npx" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">Args <span className="mem-opt">(space-separated)</span></span>
        <input type="text" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="@playwright/mcp" />
      </label>
      <div className="mem-form-actions">
        <button type="submit" disabled={!valid}>Add</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function ServerRow({ s, onDelete }: { s: McpServerInfo; onDelete: (name: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(false)
  return (
    <li className="mcp-item">
      <div className="mcp-row">
        <span className={'mcp-status ' + s.status} title={s.error ?? STATUS_LABEL[s.status]} aria-hidden="true" />
        <span className="mem-label" title={[s.command, ...(s.args ?? [])].filter(Boolean).join(' ')}>{s.name}</span>
        <span className="mcp-meta">{STATUS_LABEL[s.status]}{s.tools.length ? ` · ${s.tools.length} tools` : ''}</span>
        {confirming ? (
          <span className="mem-confirm">
            <button className="mem-confirm-yes" title="Confirm delete" aria-label="Confirm delete" onClick={() => { setConfirming(false); onDelete(s.name) }}>✓</button>
            <button className="mem-confirm-no" title="Cancel" aria-label="Cancel delete" onClick={() => setConfirming(false)}>✕</button>
          </span>
        ) : (
          <span className="mem-actions">
            {s.tools.length ? <button className="mem-edit" title="Show tools" aria-label="Show tools" onClick={() => setOpen((o) => !o)}>{open ? '▾' : '▸'}</button> : null}
            <button className="mem-del" title="Delete" aria-label="Delete server" onClick={() => setConfirming(true)}>×</button>
          </span>
        )}
      </div>
      {s.error ? <div className="mcp-error">{s.error}</div> : null}
      {open && s.tools.length ? (
        <ul className="mcp-tools">
          {s.tools.map((t) => <li key={t.name} title={t.description}>{t.name}</li>)}
        </ul>
      ) : null}
    </li>
  )
}

export function McpPanel({ servers, loading, error, onAdd, onDelete }: Props) {
  const [adding, setAdding] = useState(false)
  const anyConfigured = servers.some((s) => s.status === 'configured')
  return (
    <div className="mem-panel">
      <div className="mem-toolbar">
        <div className="persona-hint">MCP servers connect at startup. Config changes here take effect after a server restart.</div>
        <button className="mem-new" onClick={() => setAdding((a) => !a)}>＋ New</button>
      </div>

      {adding ? <AddForm onSubmit={(b) => { onAdd(b); setAdding(false) }} onCancel={() => setAdding(false)} /> : null}

      {error ? <div className="mem-error">{error}</div> : null}
      {loading ? <div className="mem-empty">Loading…</div> : null}
      {!loading && servers.length === 0 && !error ? <div className="mem-empty">No MCP servers configured.</div> : null}
      {anyConfigured ? <div className="mcp-restart-note">Some changes need a server restart to connect.</div> : null}

      <ul className="mem-list">
        {servers.map((s) => <ServerRow key={s.name} s={s} onDelete={onDelete} />)}
      </ul>
    </div>
  )
}
