import { hashPassword, verifyPassword } from './hash.js'
import { signToken, verifyToken } from './token.js'
import type { PasswordStore } from './passwordStore.js'

export interface AuthProvider {
  isConfigured(): Promise<boolean>
  setup(secret: string): Promise<void>
  verifyCredential(secret: string): Promise<boolean>
  issueToken(): string
  verifyToken(token: string): boolean
}

export class LocalPasswordAuth implements AuthProvider {
  constructor(private readonly store: PasswordStore, private readonly tokenTtlSec: number) {}
  async isConfigured(): Promise<boolean> { return this.store.hasPassword() }
  async setup(secret: string): Promise<void> {
    if (this.store.hasPassword()) throw new Error('Password already configured')
    if (!secret) throw new Error('Password must not be empty')
    this.store.setPasswordHash(hashPassword(secret))
  }
  async verifyCredential(secret: string): Promise<boolean> {
    const h = this.store.getPasswordHash()
    return h ? verifyPassword(secret, h) : false
  }
  issueToken(): string { return signToken(this.store.getTokenSecret(), this.tokenTtlSec) }
  verifyToken(token: string): boolean { return verifyToken(this.store.getTokenSecret(), token) }
}
