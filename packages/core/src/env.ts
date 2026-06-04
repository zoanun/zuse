import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd } from 'node:process'
import type { ClientConfig } from './types.js'

/**
 * 通过查找 pnpm-workspace.yaml 来定位项目根目录。
 */
function findProjectRoot(): string {
  let dir = cwd()
  while (dir !== resolve(dir, '..')) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      return dir
    }
    dir = resolve(dir, '..')
  }
  // 找不到就回退到当前工作目录
  return cwd()
}

const PROJECT_ROOT = findProjectRoot()

/**
 * 极简的 .env 加载器 —— 不需要依赖 dotenv。
 * 优先级：process.env > .env 文件
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
    // 只有在 process.env 里还没有时才设置（允许外部覆盖）
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

// 模块初始化时从项目根目录加载 .env
loadDotEnv(resolve(PROJECT_ROOT, '.env'))

/**
 * 从环境变量读取 API client 配置。
 * 同时支持 Anthropic 原生与 DashScope/Qwen 端点。
 */
export function getClientConfig(): ClientConfig {
  // 如果存在 DashScope 变量则优先使用（用户当前的配置）。
  // DashScope 的 key 必须搭配它的 base URL —— 否则请求会被发到 Anthropic
  // 默认端点，以一个令人困惑的 401 失败。
  const dashKey = process.env.DASHSCOPE_API_KEY
  if (dashKey) {
    const dashBaseURL = process.env.DASHSCOPE_BASE_URL
    if (!dashBaseURL) {
      throw new Error(
        'DASHSCOPE_API_KEY is set but DASHSCOPE_BASE_URL is missing. ' +
          'A DashScope key must be paired with its base URL.',
      )
    }
    return { apiKey: dashKey, baseURL: dashBaseURL }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || ''
  const baseURL = process.env.ANTHROPIC_BASE_URL || undefined // undefined 表示使用 Anthropic 默认端点

  if (!apiKey) {
    throw new Error(
      'API key not found. Set DASHSCOPE_API_KEY (+ DASHSCOPE_BASE_URL) or ANTHROPIC_API_KEY in .env or environment.',
    )
  }

  return { apiKey, baseURL }
}

/**
 * 从环境变量读取默认模型。
 */
export function getDefaultModel(): string {
  return (
    process.env.ZUSE_MODEL || process.env.DASHSCOPE_MODEL || 'claude-sonnet-4-5-20250514' // 回退到 Claude Sonnet 4.5
  )
}

/**
 * 从环境变量读取 max_tokens，否则用默认值。
 */
export function getDefaultMaxTokens(): number {
  const val = process.env.ZUSE_MAX_TOKENS
  if (val) {
    const parsed = parseInt(val, 10)
    if (parsed > 0) return parsed
  }
  return 4096 // 合理的默认值
}
