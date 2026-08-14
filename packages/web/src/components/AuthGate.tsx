import { useEffect, useState, type ReactNode } from 'react'

type Phase = 'checking' | 'setup' | 'login' | 'ready' | 'error'

/** 从任意响应体里取服务端那句人话；取不到就退回状态码。 */
function serverMessage(body: unknown, status: number): string {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message
  return typeof m === 'string' && m ? m : '错误 ' + status
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [msg, setMsg] = useState('')
  const [pw, setPw] = useState('')
  const [token, setToken] = useState('')
  const [tokenRequired, setTokenRequired] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/auth/status')
        // **别直接 `await r.json()`。** 隧道/反代用户最可能撞见的是网关自己的 502 HTML 错误页，
        // 那时 `r.json()` 抛，落到下面的 catch，用户看到的是 `Unexpected token '<'` ——
        // 而这次改动的全部意义就是让他们看见真实原因。
        const d = await r.json().catch(() => null)
        // **必须先看 r.ok。** 服务端在登录之前就可能拒绝（Host/Origin 闸、setup token），
        // 那时响应体是 `{error:{…}}` —— 没有 `configured` 字段。少了这一行，`!undefined`
        // 为真，用户会掉进「保护此服务器」的设密码表单，点下去再吃一个 403，
        // 而真正的原因（比如「加 --allowed-host」）一个字都看不到。
        if (!r.ok || d === null) { setPhase('error'); setMsg(serverMessage(d, r.status)); return }
        setTokenRequired(d.setupTokenRequired === true)
        setPhase(!d.configured ? 'setup' : !d.authenticated ? 'login' : 'ready')
      } catch (e) {
        setPhase('error'); setMsg(String((e as Error)?.message ?? e))
      }
    })()
  }, [])

  if (phase === 'ready') return <>{children}</>
  if (phase === 'checking') return <div className="auth-card"><p>检查中…</p></div>

  async function submit(path: string) {
    if (busy) return // guard against double-submit (Enter + click)
    setMsg(''); setBusy(true)
    try {
      // token 只在 setup 且服务端要求时才带 —— login 不认这个字段。
      const body = path.endsWith('/setup') && tokenRequired
        ? { password: pw, setupToken: token }
        : { password: pw }
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (r.ok) {
        if (path.endsWith('/setup')) { setMsg('密码已设置 — 正在重新加载…'); setTimeout(() => location.reload(), 600) }
        else setPhase('ready')
      } else if (r.status === 401) {
        setMsg('密码错误')
      } else {
        // 服务端那句话是用户唯一的线索（「用 --allowed-host … 重启」「去终端找 setup token」）。
        setMsg(serverMessage(await r.json().catch(() => null), r.status))
      }
    } catch (e) {
      setMsg('网络错误 — ' + String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const isSetup = phase === 'setup'
  const go = () => void submit(isSetup ? '/api/auth/setup' : '/api/auth/login')
  return (
    <div className="auth-card">
      <h2>{phase === 'error' ? '无法连接服务器' : isSetup ? '保护此服务器' : '欢迎回来'}</h2>
      <p>{phase === 'error' ? msg : isSetup ? '尚未设置密码。创建一个以锁定 Web 控制台 — 密码会经哈希处理并存储在本地。' : '输入密码以打开控制台。'}</p>
      {phase !== 'error' ? (
        <>
          <div className="field">
            <input type="password" placeholder={isSetup ? '新密码' : '密码'} value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') go() }} />
          </div>
          {isSetup && tokenRequired ? (
            <>
              <div className="field">
                <input type="text" placeholder="setup token" value={token} autoComplete="off"
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') go() }} />
              </div>
              {/* 不加 class：`.auth-card p` 已经给了 `--muted`。全仓**没有** `.faint` 这个类
                  （只有 `--faint` 变量），写上去就是又一个「有 class 没规则」的死样式。 */}
              <p style={{ marginTop: 10 }}>这台 daemon 对外可达，首次设置口令要贴启动时生成的 token —— 在启动 daemon 的终端里找 <code>setup token:</code> 那一行，或读 daemon 数据目录下的 <code>setup-token</code> 文件。</p>
            </>
          ) : null}
          <button style={{ marginTop: 14, width: '100%' }} disabled={busy} onClick={go}>
            {busy ? '处理中…' : isSetup ? '设置密码' : '登录'}
          </button>
          <div className="msg-error">{msg}</div>
        </>
      ) : null}
    </div>
  )
}
