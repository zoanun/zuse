import { useState } from 'react'
import type { McpServerInfo } from '@zuse/protocol'
import type { AddMcpBody } from '../state/manageApi.js'

interface Props {
  servers: McpServerInfo[]
  loading?: boolean
  error?: string | null
  onAdd: (body: AddMcpBody) => void
  onDelete: (name: string) => void
  /** Live reconnect of ALL servers from current settings (apply add/delete without a restart). */
  onReconnect: () => void
  /** Live reconnect of a single server by name. */
  onReconnectServer: (name: string) => void
}

const STATUS_LABEL: Record<McpServerInfo['status'], string> = {
  connected: '已连接', failed: '失败', configured: '重启后连接',
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
        <span className="mem-field-label">名称</span>
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 playwright" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">命令</span>
        <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="例如 npx" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">参数 <span className="mem-opt">(空格分隔)</span></span>
        <input type="text" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="@playwright/mcp" />
      </label>
      <div className="mem-form-actions">
        <button type="submit" disabled={!valid}>新增</button>
        <button type="button" className="ghost" onClick={onCancel}>取消</button>
      </div>
    </form>
  )
}

function ServerRow({ s, onDelete, onReconnect }: { s: McpServerInfo; onDelete: (name: string) => void; onReconnect: (name: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(false)
  return (
    <li className="mcp-item">
      <div className="mcp-row">
        <span className={'mcp-status ' + s.status} title={s.error ?? STATUS_LABEL[s.status]} aria-hidden="true" />
        <span className="mem-label" title={[s.command, ...(s.args ?? [])].filter(Boolean).join(' ')}>{s.name}</span>
        <span className="mcp-meta">{STATUS_LABEL[s.status]}{s.tools.length ? ` · ${s.tools.length} 个工具` : ''}</span>
        {confirming ? (
          <span className="mem-confirm">
            <button className="mem-confirm-yes" title="确认删除" aria-label="确认删除" onClick={() => { setConfirming(false); onDelete(s.name) }}>✓</button>
            <button className="mem-confirm-no" title="取消" aria-label="取消删除" onClick={() => setConfirming(false)}>✕</button>
          </span>
        ) : (
          <span className="mem-actions">
            {s.tools.length ? <button className="mem-edit" title="查看工具" aria-label="查看工具" onClick={() => setOpen((o) => !o)}>{open ? '▾' : '▸'}</button> : null}
            <button className="mem-edit" title="重连此服务器" aria-label="重连服务器" onClick={() => onReconnect(s.name)}>↻</button>
            <button className="mem-del" title="删除" aria-label="删除服务器" onClick={() => setConfirming(true)}>×</button>
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

export function McpPanel({ servers, loading, error, onAdd, onDelete, onReconnect, onReconnectServer }: Props) {
  const [adding, setAdding] = useState(false)
  const anyConfigured = servers.some((s) => s.status === 'configured')
  return (
    <div className="mem-panel">
      <div className="mem-toolbar">
        <div className="persona-hint">新增/移除服务器后，点击重连以生效（无需重启服务器）。</div>
        <button className="mem-new ghost" title="按当前配置重连 MCP 服务器" onClick={onReconnect}>↻ 重连</button>
        <button className="mem-new" onClick={() => setAdding((a) => !a)}>＋ 新增</button>
      </div>

      {adding ? <AddForm onSubmit={(b) => { onAdd(b); setAdding(false) }} onCancel={() => setAdding(false)} /> : null}

      {error ? <div className="mem-error">{error}</div> : null}
      {loading ? <div className="mem-empty">加载中…</div> : null}
      {!loading && servers.length === 0 && !error ? <div className="mem-empty">未配置 MCP 服务器</div> : null}
      {anyConfigured ? <div className="mcp-restart-note">待生效的服务器尚未连接 —— 点击重连以生效。</div> : null}

      <ul className="mem-list">
        {servers.map((s) => <ServerRow key={s.name} s={s} onDelete={onDelete} onReconnect={onReconnectServer} />)}
      </ul>
    </div>
  )
}
