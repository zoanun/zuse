import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

interface AuthFile { version: 1; passwordHash?: string; tokenSecret: string }

export class PasswordStore {
  private readonly path: string
  private data: AuthFile

  constructor(dir: string) {
    this.path = join(dir, 'web-auth.json')
    this.data = this.load(dir)
  }

  private load(dir: string): AuthFile {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AuthFile>
        if (parsed && typeof parsed.tokenSecret === 'string') {
          return { version: 1, passwordHash: parsed.passwordHash, tokenSecret: parsed.tokenSecret }
        }
      } catch { /* fall through to fresh */ }
    }
    const fresh: AuthFile = { version: 1, tokenSecret: randomBytes(32).toString('base64') }
    mkdirSync(dir, { recursive: true })
    this.persist(fresh)
    return fresh
  }

  private persist(data: AuthFile): void {
    writeFileSync(this.path, JSON.stringify(data, null, 2), 'utf8')
    try { chmodSync(this.path, 0o600) } catch { /* windows / best-effort */ }
  }

  hasPassword(): boolean { return typeof this.data.passwordHash === 'string' && this.data.passwordHash.length > 0 }
  getPasswordHash(): string | undefined { return this.data.passwordHash }
  setPasswordHash(hash: string): void { this.data.passwordHash = hash; this.persist(this.data) }
  getTokenSecret(): string { return this.data.tokenSecret }
}
