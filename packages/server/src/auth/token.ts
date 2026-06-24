import { createHmac, timingSafeEqual } from 'node:crypto'

function b64url(buf: Buffer): string { return buf.toString('base64url') }
function hmac(secret: string, data: string): Buffer { return createHmac('sha256', secret).update(data).digest() }

/** token = base64url(payloadJSON) + "." + base64url(hmac). payload = { iat, exp } (seconds). */
export function signToken(secret: string, ttlSec: number): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = JSON.stringify({ iat: now, exp: now + ttlSec })
  const p = b64url(Buffer.from(payload, 'utf8'))
  const sig = b64url(hmac(secret, p))
  return `${p}.${sig}`
}

export function verifyToken(secret: string, token: string): boolean {
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const p = token.slice(0, dot), sig = token.slice(dot + 1)
  let expected: Buffer, given: Buffer
  try { expected = hmac(secret, p); given = Buffer.from(sig, 'base64url') }
  catch { return false }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  let payload: { exp?: number }
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) }
  catch { return false }
  return typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) < payload.exp
}
