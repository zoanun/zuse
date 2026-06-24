export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export interface CookieOpts { httpOnly?: boolean; sameSite?: 'Lax' | 'Strict' | 'None'; maxAgeSec?: number; secure?: boolean; path?: string }

export function serializeCookie(name: string, value: string, opts: CookieOpts = {}): string {
  const segs = [`${name}=${value}`, `Path=${opts.path ?? '/'}`]
  if (opts.maxAgeSec !== undefined) segs.push(`Max-Age=${opts.maxAgeSec}`)
  if (opts.httpOnly) segs.push('HttpOnly')
  if (opts.sameSite) segs.push(`SameSite=${opts.sameSite}`)
  if (opts.secure) segs.push('Secure')
  return segs.join('; ')
}
