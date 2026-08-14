import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AuthGate } from './AuthGate.js'

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
  vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch))
}
const json = (body: unknown, ok = true, status = 200): Partial<Response> =>
  ({ ok, status, json: async () => body })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('AuthGate', () => {
  it('shows the setup form when the server is not configured', async () => {
    mockFetch(async () => json({ configured: false, authenticated: false }))
    render(<AuthGate><div>secret app</div></AuthGate>)
    expect(await screen.findByText('保护此服务器')).toBeInTheDocument()
    expect(screen.queryByText('secret app')).toBeNull()
  })

  it('shows the login form when configured but not authenticated', async () => {
    mockFetch(async () => json({ configured: true, authenticated: false }))
    render(<AuthGate><div>secret app</div></AuthGate>)
    expect(await screen.findByText('欢迎回来')).toBeInTheDocument()
  })

  it('renders children when already authenticated', async () => {
    mockFetch(async () => json({ configured: true, authenticated: true }))
    render(<AuthGate><div>secret app</div></AuthGate>)
    expect(await screen.findByText('secret app')).toBeInTheDocument()
  })

  it('shows the error phase when the status check fails', async () => {
    mockFetch(async () => { throw new Error('boom') })
    render(<AuthGate><div>secret app</div></AuthGate>)
    expect(await screen.findByText('无法连接服务器')).toBeInTheDocument()
  })

  it('surfaces "Incorrect password" on a 401 login', async () => {
    mockFetch(async (url) =>
      url.endsWith('/status')
        ? json({ configured: true, authenticated: false })
        : json({}, false, 401))
    render(<AuthGate><div>secret app</div></AuthGate>)
    const input = await screen.findByPlaceholderText('密码')
    fireEvent.change(input, { target: { value: 'wrong' } })
    fireEvent.click(screen.getByText('登录'))
    expect(await screen.findByText('密码错误')).toBeInTheDocument()
  })

  it('shows a network-error message when login fetch rejects', async () => {
    let first = true
    mockFetch(async () => {
      if (first) { first = false; return json({ configured: true, authenticated: false }) }
      throw new Error('offline')
    })
    render(<AuthGate><div>secret app</div></AuthGate>)
    const input = await screen.findByPlaceholderText('密码')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.click(screen.getByText('登录'))
    await waitFor(() => expect(screen.getByText(/网络错误/)).toBeInTheDocument())
  })
})

/**
 * 服务端在**登录之前**就可能拒绝请求（Host/Origin 闸的 403、setup token 的 403）。
 * 这一组测的是「用户看不看得懂被拒了、知不知道怎么办」——
 * 一个没有线索的 403 在用户看来就是「远程访问被封死了」。
 */
describe('AuthGate 的前置拒绝与 setup token', () => {
  /**
   * **第 1 步（Host/Origin 闸）就埋下的断链。** `/api/auth/status` 被 403 时，
   * 响应体是 `{error:{…}}` —— 没有 `configured` 字段，于是 `!undefined` 为真、
   * 组件掉进 **setup 界面**。隧道用户没加 `--allowed-host` 时看到的不是
   * 「Host 不在允许列表」，而是一个「保护此服务器」的设密码表单，点下去再吃一个 403。
   */
  it('status 被 403 时进错误界面并显示服务端说明，而不是掉进设密码表单', async () => {
    mockFetch(async () => json({ error: { code: 'host_not_allowed', message: '用 --allowed-host xyz.example 重启 daemon' } }, false, 403))
    render(<AuthGate><div>secret app</div></AuthGate>)
    expect(await screen.findByText('无法连接服务器')).toBeInTheDocument()
    expect(screen.getByText(/--allowed-host xyz.example/)).toBeInTheDocument()
    expect(screen.queryByText('保护此服务器')).toBeNull()
  })

  /**
   * 隧道 / 反代用户最可能撞见的是网关自己的 HTML 错误页。直接 `await r.json()` 的话
   * 用户看到的是 `Unexpected token '<'` —— 而这次改动的全部意义就是让他们看见真实原因。
   */
  it('响应不是 JSON（网关 502 的 HTML）时给出状态码，不是 JSON 解析错', async () => {
    mockFetch(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token '<'") } }))
    render(<AuthGate><div>secret app</div></AuthGate>)
    expect(await screen.findByText('无法连接服务器')).toBeInTheDocument()
    expect(screen.getByText('错误 502')).toBeInTheDocument()
    expect(screen.queryByText(/Unexpected token/)).toBeNull()
  })

  it('setupTokenRequired 时渲染 token 输入框，并把它一起提交', async () => {
    let sentBody: string | undefined
    mockFetch(async (url, init) => {
      if (url.endsWith('/status')) return json({ configured: false, authenticated: false, setupTokenRequired: true })
      sentBody = init?.body as string
      return json({ ok: true })
    })
    render(<AuthGate><div>secret app</div></AuthGate>)
    const token = await screen.findByPlaceholderText('setup token')
    fireEvent.change(screen.getByPlaceholderText('新密码'), { target: { value: 'pw' } })
    fireEvent.change(token, { target: { value: 'TOK' } })
    fireEvent.click(screen.getByText('设置密码'))
    await waitFor(() => expect(sentBody).toBeDefined())
    expect(JSON.parse(sentBody!)).toEqual({ password: 'pw', setupToken: 'TOK' })
  })

  it('不需要 token 时不渲染那个输入框（本机开发不多一步）', async () => {
    mockFetch(async () => json({ configured: false, authenticated: false, setupTokenRequired: false }))
    render(<AuthGate><div>secret app</div></AuthGate>)
    expect(await screen.findByText('保护此服务器')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('setup token')).toBeNull()
  })

  /** 提交被拒时必须显示服务端那句话 —— 只显示「错误 403」等于没有任何线索。 */
  it('setup 被 403 时显示服务端的 message，不是「错误 403」', async () => {
    mockFetch(async (url) =>
      url.endsWith('/status')
        ? json({ configured: false, authenticated: false, setupTokenRequired: true })
        : json({ error: { code: 'setup_token_invalid', message: 'setup token 不正确。去终端找那一行' } }, false, 403))
    render(<AuthGate><div>secret app</div></AuthGate>)
    fireEvent.change(await screen.findByPlaceholderText('新密码'), { target: { value: 'pw' } })
    fireEvent.change(screen.getByPlaceholderText('setup token'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByText('设置密码'))
    expect(await screen.findByText(/setup token 不正确/)).toBeInTheDocument()
  })
})
