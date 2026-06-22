/**
 * 降级(failover)的纯决策逻辑,不依赖 React/ink,便于单测。
 * useConversation 在 error 事件后调用:先 badKeysForFailure 标坏,再 decideFailover 决定动作。
 */
import type { ErrorCategory } from './types.js'

/** key 形如 `${providerId}/${model}`,与 buildModelOptions 的标注 key 一致。 */
export function modelKey(providerId: string, model: string): string {
  return `${providerId}/${model}`
}

/**
 * 本次失败应标坏哪些 key。
 * - auth(401):整个 provider 共享一个 key,失效则全 provider 不可用 → 标该 provider 所有声明 model。
 * - 其余(quota/unavailable):只标当前 provider/model。
 */
export function badKeysForFailure(
  providerId: string,
  currentModel: string,
  category: ErrorCategory,
  models: string[],
): string[] {
  if (category === 'auth') return models.map((m) => modelKey(providerId, m))
  return [modelKey(providerId, currentModel)]
}

export type FailoverAction = { kind: 'retry'; model: string } | { kind: 'dialog' }

export interface FailoverInput {
  category: ErrorCategory
  mode: 'dialog' | 'auto'
  providerId: string
  /** settings.providers[providerId].models;扁平/未声明则空数组。 */
  models: string[]
  currentModel: string
  /** 已标坏 key 集合(调用方须先把本次失败的 key 加进来再调本函数)。 */
  bad: Set<string>
}

/**
 * 决定降级动作。
 * - dialog 模式、或 auth、或 auto 找不到下家 → 弹框。
 * - auto + 非 auth + 有未坏下家 → retry(按 models 声明顺序取第一个未坏且非当前的)。
 */
export function decideFailover(input: FailoverInput): FailoverAction {
  const { category, mode, providerId, models, currentModel, bad } = input
  if (mode === 'dialog' || category === 'auth') return { kind: 'dialog' }
  const next = models.find((m) => m !== currentModel && !bad.has(modelKey(providerId, m)))
  return next ? { kind: 'retry', model: next } : { kind: 'dialog' }
}
