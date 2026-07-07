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
  // Esc dismisses the menu even though input still starts with '/'. Cleared whenever the input changes.
  const [menuDismissed, setMenuDismissed] = useState(false)
  // Command menu: candidate list derived from current input + a highlighted index.
  const menu = filterCommands(value, commands)
  const menuOpen = menu.length > 0 && !menuDismissed
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
    setMenuDismissed(false)
  }

  // Caret-position helpers so multi-line editing keeps normal arrow behavior; history only kicks in
  // at the text boundary (caret on the first line for ↑, last line for ↓), shell-style.
  function caretOnFirstLine() {
    const ta = taRef.current
    if (!ta) return true
    return ta.value.slice(0, ta.selectionStart).indexOf('\n') === -1
  }
  function caretOnLastLine() {
    const ta = taRef.current
    if (!ta) return true
    return ta.value.slice(ta.selectionStart).indexOf('\n') === -1
  }
  const draftRef = useRef('')
  function recallPrev() {
    if (history.length === 0) return
    const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1)
    if (histIdx === null) draftRef.current = value // entering history: stash the draft
    setHistIdx(next); setText(history[next]!)
  }
  function recallNext() {
    if (histIdx === null) return
    const next = histIdx + 1
    if (next >= history.length) { setHistIdx(null); setText(draftRef.current); return } // back to draft
    setHistIdx(next); setText(history[next]!)
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
          onChange={(e) => { setText(e.target.value); setHistIdx(null); setMenuDismissed(false) }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            // 1) Command menu open: arrows/enter/tab/esc drive the menu.
            if (menuOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIdx((i) => (i + 1) % menu.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIdx((i) => (i - 1 + menu.length) % menu.length); return }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runCommand(menu[menuIdx]!); return }
              if (e.key === 'Escape') { e.preventDefault(); setMenuDismissed(true); return }
            }
            // 2) Menu closed: Enter sends.
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            // 3) Menu closed, not in command-input state: arrows navigate input history.
            if (!value.startsWith('/')) {
              if (e.key === 'ArrowUp' && caretOnFirstLine()) { e.preventDefault(); recallPrev(); return }
              if (e.key === 'ArrowDown' && caretOnLastLine()) { e.preventDefault(); recallNext(); return }
            }
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
