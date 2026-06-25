import { useEffect, useState, type ReactNode } from 'react'

type Phase = 'checking' | 'setup' | 'login' | 'ready' | 'error'

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [msg, setMsg] = useState('')
  const [pw, setPw] = useState('')

  useEffect(() => {
    fetch('/api/auth/status').then((r) => r.json()).then((d) => {
      setPhase(!d.configured ? 'setup' : !d.authenticated ? 'login' : 'ready')
    }).catch((e) => { setPhase('error'); setMsg(String(e?.message ?? e)) })
  }, [])

  if (phase === 'ready') return <>{children}</>
  if (phase === 'checking') return <div className="auth-card"><p>checking…</p></div>

  async function submit(path: string) {
    setMsg('')
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })
    if (r.ok) {
      if (path.endsWith('/setup')) { setMsg('Password set — reloading…'); setTimeout(() => location.reload(), 600) }
      else setPhase('ready')
    } else setMsg(r.status === 401 ? 'Incorrect password' : 'error ' + r.status)
  }

  const isSetup = phase === 'setup'
  return (
    <div className="auth-card">
      <h2>{phase === 'error' ? 'Server unreachable' : isSetup ? 'Protect this server' : 'Welcome back'}</h2>
      <p>{phase === 'error' ? msg : isSetup ? 'No password is set yet. Create one to lock the web console — it is hashed and stored locally.' : 'Enter your password to open the console.'}</p>
      {phase !== 'error' ? (
        <>
          <div className="field">
            <input type="password" placeholder={isSetup ? 'New password' : 'Password'} value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(isSetup ? '/api/auth/setup' : '/api/auth/login') }} />
          </div>
          <button style={{ marginTop: 14, width: '100%' }} onClick={() => void submit(isSetup ? '/api/auth/setup' : '/api/auth/login')}>
            {isSetup ? 'Set password' : 'Log in'}
          </button>
          <div className="msg-error">{msg}</div>
        </>
      ) : null}
    </div>
  )
}
