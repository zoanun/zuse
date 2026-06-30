import { useEffect, useState, type ReactNode } from 'react'

type Phase = 'checking' | 'setup' | 'login' | 'ready' | 'error'

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [msg, setMsg] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/auth/status').then((r) => r.json()).then((d) => {
      setPhase(!d.configured ? 'setup' : !d.authenticated ? 'login' : 'ready')
    }).catch((e) => { setPhase('error'); setMsg(String(e?.message ?? e)) })
  }, [])

  if (phase === 'ready') return <>{children}</>
  if (phase === 'checking') return <div className="auth-card"><p>检查中…</p></div>

  async function submit(path: string) {
    if (busy) return // guard against double-submit (Enter + click)
    setMsg(''); setBusy(true)
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })
      if (r.ok) {
        if (path.endsWith('/setup')) { setMsg('密码已设置 — 正在重新加载…'); setTimeout(() => location.reload(), 600) }
        else setPhase('ready')
      } else setMsg(r.status === 401 ? '密码错误' : '错误 ' + r.status)
    } catch (e) {
      setMsg('网络错误 — ' + String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const isSetup = phase === 'setup'
  return (
    <div className="auth-card">
      <h2>{phase === 'error' ? '无法连接服务器' : isSetup ? '保护此服务器' : '欢迎回来'}</h2>
      <p>{phase === 'error' ? msg : isSetup ? '尚未设置密码。创建一个以锁定 Web 控制台 — 密码会经哈希处理并存储在本地。' : '输入密码以打开控制台。'}</p>
      {phase !== 'error' ? (
        <>
          <div className="field">
            <input type="password" placeholder={isSetup ? '新密码' : '密码'} value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(isSetup ? '/api/auth/setup' : '/api/auth/login') }} />
          </div>
          <button style={{ marginTop: 14, width: '100%' }} disabled={busy} onClick={() => void submit(isSetup ? '/api/auth/setup' : '/api/auth/login')}>
            {busy ? '处理中…' : isSetup ? '设置密码' : '登录'}
          </button>
          <div className="msg-error">{msg}</div>
        </>
      ) : null}
    </div>
  )
}
