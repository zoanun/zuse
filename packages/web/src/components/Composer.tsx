import { useEffect, useRef, useState } from 'react'
import type { SlashCommand } from './commands.js'
import { filterCommands } from './commands.js'

interface ComposerProps {
  thinking: boolean
  onSend: (text: string) => void
  onStop: () => void
  history?: string[]
  commands?: SlashCommand[]
  onRunCommand?: (cmd: SlashCommand) => void
}

export function Composer({ thinking, onSend, onStop, history = [], commands = [], onRunCommand }: ComposerProps) {
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  // Command menu: candidate list derived from current input + a highlighted index.
  const menu = filterCommands(value, commands)
  const menuOpen = menu.length > 0
  const [menuIdx, setMenuIdx] = useState(0)
  // History cursor: null = editing a fresh draft; otherwise an index into `history` (0 = oldest).
  const [histIdx, setHistIdx] = useState<number | null>(null)

  useEffect(() => { taRef.current?.focus() }, [])
  useEffect(() => { if (!thinking) taRef.current?.focus() }, [thinking])
  // New session → fresh history array → reset the cursor.
  useEffect(() => { setHistIdx(null) }, [history])
  // Keep the highlight in range as the candidate list shrinks/grows.
  useEffect(() => { setMenuIdx(0) }, [value])

  function setText(v: string) {
    setValue(v)
    const ta = taRef.current
    if (ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 168) + 'px' }
  }

  function submit() {
    const v = value.trim()
    if (!v) return
    // Sending is allowed even while `thinking`: Shell routes it to a mid-turn steer.
    onSend(v)
    setValue(''); setHistIdx(null)
    if (taRef.current) { taRef.current.style.height = 'auto'; taRef.current.focus() }
  }

  function runCommand(cmd: SlashCommand) {
    onRunCommand?.(cmd)
    setValue(''); setHistIdx(null)
    if (taRef.current) { taRef.current.style.height = 'auto'; taRef.current.focus() }
  }

  return (
    <div className="composer-wrap">
      {menuOpen ? (
        <ul className="slash-menu" role="listbox" aria-label="命令">
          {menu.map((c, i) => (
            <li
              key={c.name}
              role="option"
              aria-selected={i === menuIdx}
              className={'slash-item' + (i === menuIdx ? ' active' : '')}
              onMouseDown={(e) => e.preventDefault()} // keep textarea focus; run on click
              onClick={() => runCommand(c)}
            >
              <span className="slash-name">{c.name}</span>
              <span className="slash-desc">{c.desc}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={thinking ? '插入消息到当前回合…' : '给 zuse 发消息…'}
          value={value}
          onChange={(e) => { setText(e.target.value); setHistIdx(null) }}
          onKeyDown={(e) => {
            // !isComposing: don't treat the Enter that confirms an IME candidate as a send.
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
          }}
        />
        {thinking ? (
          <button className="ghost stop-btn" aria-label="停止" onClick={onStop}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
          </button>
        ) : null}
        <button className="send-btn" aria-label="发送消息" disabled={value.trim() === ''} onClick={submit}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 10 4 15 9 20" />
            <path d="M20 4v7a4 4 0 0 1-4 4H4" />
          </svg>
        </button>
      </div>
    </div>
  )
}
