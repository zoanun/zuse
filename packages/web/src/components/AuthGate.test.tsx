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
