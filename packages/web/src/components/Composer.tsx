import { useEffect, useRef, useState } from 'react'

export function Composer({ disabled, onSend, onStop }: { disabled: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Focus on mount
  useEffect(() => {
    taRef.current?.focus()
  }, [])

  // Refocus when the reply finishes (disabled: true → false)
  useEffect(() => {
    if (!disabled) taRef.current?.focus()
  }, [disabled])

  function submit() {
    const v = value.trim()
    if (!v || disabled) return
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
          placeholder="Message zuse…"
          value={value}
          disabled={disabled}
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
        {disabled ? <button className="ghost" onClick={onStop}>Stop</button> : null}
        <button className="send-btn" aria-label="Send message" onClick={submit} disabled={disabled}>↑</button>
      </div>
    </div>
  )
}
