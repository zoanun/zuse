import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd } from 'node:process'
import type { ClientConfig } from './types.js'

/**
 * Find the project root directory by looking for pnpm-workspace.yaml
 */
function findProjectRoot(): string {
  let dir = cwd()
  while (dir !== resolve(dir, '..')) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      return dir
    }
    dir = resolve(dir, '..')
  }
  // Fallback to cwd if not found
  return cwd()
}

const PROJECT_ROOT = findProjectRoot()

/**
 * Minimal .env loader — no dotenv dependency needed.
 * Priority: process.env > .env file
 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    // Only set if not already in process.env (allows override)
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

// Load .env from project root on module init
loadDotEnv(resolve(PROJECT_ROOT, '.env'))

/**
 * Get API client config from environment.
 * Supports both Anthropic native and DashScope/Qwen endpoints.
 */
export function getClientConfig(): ClientConfig {
  // Prefer DashScope vars if present (user's current setup)
  const apiKey =
    process.env.DASHSCOPE_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    ''

  const baseURL =
    process.env.DASHSCOPE_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    undefined  // undefined means use Anthropic default

  if (!apiKey) {
    throw new Error(
      'API key not found. Set DASHSCOPE_API_KEY or ANTHROPIC_API_KEY in .env or environment.'
    )
  }

  return { apiKey, baseURL }
}

/**
 * Get default model from environment.
 */
export function getDefaultModel(): string {
  return (
    process.env.ZUSE_MODEL ||
    process.env.DASHSCOPE_MODEL ||
    'claude-sonnet-4-5-20250514'  // fallback to Claude Sonnet 4.5
  )
}

/**
 * Get max_tokens from environment or default.
 */
export function getDefaultMaxTokens(): number {
  const val = process.env.ZUSE_MAX_TOKENS
  if (val) {
    const parsed = parseInt(val, 10)
    if (parsed > 0) return parsed
  }
  return 4096  // sensible default
}
