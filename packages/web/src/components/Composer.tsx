import { useEffect, useRef, useState } from 'react'

export function Composer({ thinking, onSend, onStop }: { thinking: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Focus on mount
  useEffect(() => {
    taRef.current?.focus()
  }, [])

  // Refocus when the reply finishes (thinking: true → false)
  useEffect(() => {
    if (!thinking) taRef.current?.focus()
  }, [thinking])

  function submit() {
    const v = value.trim()
    if (!v) return
    // Sending is allowed even while `thinking`: Shell routes it to a mid-turn steer instead of a
    // fresh turn. So the composer never hard-disables input — only the button set changes.
    onSend(v); setValue('')
    if (taRef.current) {
      taRef.current.style.height = 'auto'
      // Refocus after send so the user can type the next message immediately
      taRef.current.focus()
    }
  }
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={thinking ? '插入消息到当前回合…' : '给 zuse 发消息…'}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 168) + 'px'
          }}
          onKeyDown={(e) => {
            // !isComposing: don't treat the Enter that confirms an IME candidate
            // (Chinese/Japanese input) as a send — it would fire a half-composed message.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
          }}
        />
        {thinking ? <button className="ghost" onClick={onStop}>停止</button> : null}
        <button className="send-btn" aria-label="发送消息" onClick={submit}>↑</button>
      </div>
    </div>
  )
}
