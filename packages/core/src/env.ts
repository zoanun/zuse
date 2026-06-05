import type { ClientConfig, ResolvedSettings } from './types.js'

/**
 * 从已解析的 settings 读取 API client 配置。
 * apiKey 优先级：process.env.ZUSE_API_KEY > settings.apiKey
 *（loadSettings 已把 ZUSE_API_KEY 合并进 settings.apiKey，这里再兜一层）。
 */
export function getClientConfig(settings: ResolvedSettings): ClientConfig {
  const apiKey = process.env.ZUSE_API_KEY || settings.apiKey || ''
  if (!apiKey) {
    throw new Error(
      'API key not found. Set "apiKey" in ~/.zuse/settings.json or <repo>/.zuse/settings.local.json, ' +
      'or export ZUSE_API_KEY.',
    )
  }
  return { apiKey, baseURL: settings.baseURL }
}

/** 默认模型：settings.model，否则回退。 */
export function getDefaultModel(settings: ResolvedSettings): string {
  return settings.model || 'claude-sonnet-4-5-20250514'
}

/** max_tokens：settings.maxTokens，否则回退 4096。 */
export function getDefaultMaxTokens(settings: ResolvedSettings): number {
  return settings.maxTokens && settings.maxTokens > 0 ? settings.maxTokens : 4096
}
