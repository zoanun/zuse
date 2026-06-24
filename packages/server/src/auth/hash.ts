import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'

const N = 16384, KEYLEN = 64

/** Returns `scrypt$<N>$<saltB64>$<hashB64>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N })
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  if (!Number.isInteger(n) || n <= 1) return false
  let salt: Buffer, expected: Buffer
  try {
    salt = Buffer.from(parts[2]!, 'base64')
    expected = Buffer.from(parts[3]!, 'base64')
  } catch { return false }
  let actual: Buffer
  try { actual = scryptSync(password, salt, expected.length, { N: n }) as Buffer }
  catch { return false }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
