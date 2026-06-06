import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { cwd } from 'node:process'
import {
  parse as parseJsonc,
  modify,
  applyEdits,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser'
import type {
  ResolvedSettings,
  PermissionMode,
  RawProviderConfig,
  ProviderConfig,
  ModelSelection,
  RawWebSearchConfig,
  WebSearchConfig,
} from './types.js'
import { createModelClient } from './model-client.js'
import type { ModelClient } from './model-client.js'

// 默认 provider 标识符与默认模型（未配置 model 时的回退）。
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250514'
/** 扁平配置合成出的 provider id。导出供 TUI 判断「是否扁平默认」以决定写盘格式。 */
export const DEFAULT_PROVIDER_ID = 'default'

/** 通过查找 pnpm-workspace.yaml 定位项目根（从 env.ts 迁来，统一出口）。 */
export function findProjectRoot(): string {
  let dir = cwd()
  while (dir !== resolve(dir, '..')) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
    dir = resolve(dir, '..')
  }
  return cwd()
}

/** 单层文件的原始（未补默认值）形状，全部可选。 */
interface RawSettings {
  model?: string
  maxTokens?: number
  baseURL?: string
  apiKey?: string
  proxy?: string
  tools?: { enabled?: string[]; disabled?: string[] }
  permissions?: {
    defaultMode?: PermissionMode
    allow?: string[]
    ask?: string[]
    deny?: string[]
  }
  providers?: Record<string, RawProviderConfig>
  webSearch?: RawWebSearchConfig
}

export interface LoadSettingsOptions {
  userPath?: string
  projectPath?: string
  localPath?: string
}

/**
 * 给定一个 .json 基准路径，返回实际生效的配置文件路径。
 * 同名 .jsonc 优先（更可能是用户手写、带注释的那份），其次回退到 .json；
 * 两者都不存在则返回基准路径（readLayer 会按"文件缺失"处理）。三层共用。
 */
function resolveLayerPath(basePath: string): string {
  const jsoncPath = basePath.endsWith('.json') ? `${basePath}c` : basePath
  if (jsoncPath !== basePath && existsSync(jsoncPath)) return jsoncPath
  return basePath
}

/** 读取并解析一层；文件缺失返回空对象，解析失败抛出指明文件名的错误。 */
function readLayer(path: string): RawSettings {
  if (!existsSync(path)) return {}
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to read settings file ${path}: ${msg}`)
  }
  // 用 jsonc-parser 解析：容忍 // 行注释、/* */ 块注释和尾逗号（JSONC）。
  // 它能识别字符串，所以 baseURL 里的 "https://..." 不会被当成注释删掉。
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const detail = errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join('; ')
    throw new Error(`Failed to parse settings file ${path}: ${detail}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Failed to parse settings file ${path}: top-level value must be a JSON object`)
  }
  return parsed as RawSettings
}

/** 低 → 高 合并：标量高层覆盖、permission 数组跨层拼接、tools 浅合并。 */
function mergeLayers(layers: RawSettings[]): ResolvedSettings {
  const out: ResolvedSettings = {
    tools: {},
    permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
    providers: {},
  }
  for (const layer of layers) {
    if (layer.model !== undefined) out.model = layer.model
    if (layer.maxTokens !== undefined) out.maxTokens = layer.maxTokens
    if (layer.baseURL !== undefined) out.baseURL = layer.baseURL
    if (layer.apiKey !== undefined) out.apiKey = layer.apiKey
    if (layer.proxy !== undefined) out.proxy = layer.proxy
    if (layer.tools) out.tools = { ...out.tools, ...layer.tools }
    // 按 provider id 深合并：高层标量覆盖，字段级合并。
    if (layer.providers) {
      for (const [id, p] of Object.entries(layer.providers)) {
        out.providers[id] = { ...(out.providers[id] ?? {}), ...p }
      }
    }
    // webSearch 深合并：标量（backend/maxResults/fallback）由高层覆盖，
    // backends 按后端名合并（与 providers 同款），让各层各补各的 key。
    // fallback 用覆盖而非拼接：回退顺序应可被高层整体改写，而非追加。
    if (layer.webSearch) {
      const prev = out.webSearch ?? {}
      out.webSearch = {
        ...prev,
        ...layer.webSearch,
        backends: { ...(prev.backends ?? {}), ...(layer.webSearch.backends ?? {}) },
      }
    }
    const pm = layer.permissions
    if (pm) {
      if (pm.defaultMode !== undefined) out.permissions.defaultMode = pm.defaultMode
      if (pm.allow) out.permissions.allow.push(...pm.allow)
      if (pm.ask) out.permissions.ask.push(...pm.ask)
      if (pm.deny) out.permissions.deny.push(...pm.deny)
    }
  }
  const envKey = process.env.ZUSE_API_KEY
  if (envKey) out.apiKey = envKey
  // 代理也支持环境变量覆盖（与 apiKey 同款）：ZUSE_PROXY 优先于任意层的字面量。
  const envProxy = process.env.ZUSE_PROXY
  if (envProxy) out.proxy = envProxy
  return out
}

/** 三层加载 + 合并。优先级 用户 < 项目 < 本地。 */
export function loadSettings(opts: LoadSettingsOptions = {}): ResolvedSettings {
  const root = findProjectRoot()
  const userPath = opts.userPath ?? join(homedir(), '.zuse', 'settings.json')
  const projectPath = opts.projectPath ?? join(root, '.zuse', 'settings.json')
  const localPath = opts.localPath ?? join(root, '.zuse', 'settings.local.json')
  return mergeLayers([
    readLayer(resolveLayerPath(userPath)),
    readLayer(resolveLayerPath(projectPath)),
    readLayer(resolveLayerPath(localPath)),
  ])
}

/**
 * 把一条 allow 规则写入本地层 settings.local.json 的 permissions.allow。
 * 文件/目录不存在则创建；同规则已存在则去重跳过。只写本地层。
 * @param localPath 省略时取 <项目根>/.zuse/settings.local.json
 */
export function appendAllowRule(rule: string, localPath?: string): void {
  const basePath = localPath ?? join(findProjectRoot(), '.zuse', 'settings.local.json')
  // 已存在 .jsonc 版本就地写它，免得把带注释的配置劈成 .json/.jsonc 两个文件。
  const path = resolveLayerPath(basePath)
  // 以原文为基底（缺失/空/读不动都退回 "{}"），这样能保留用户的注释和格式。
  let text = '{}'
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8')
      if (raw.trim()) text = raw
    } catch {
      text = '{}' // 读不动就当空对象重建
    }
  }
  // 取现有 allow（容忍注释/尾逗号）；坏文件按空对象处理，不阻断放行。
  const data = (parseJsonc(text, [], { allowTrailingComma: true }) ?? {}) as RawSettings
  const existing = data.permissions?.allow ?? []
  if (existing.includes(rule)) return // 已有则幂等跳过，连写盘都省了
  // 只改 permissions.allow 这一处，applyEdits 保留其余字段、注释与缩进。
  const edits = modify(text, ['permissions', 'allow'], [...existing, rule], {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const updated = applyEdits(text, edits)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, updated.endsWith('\n') ? updated : updated + '\n', 'utf8')
}

/** max_tokens：settings.maxTokens，否则回退 4096。 */
export function getDefaultMaxTokens(settings: ResolvedSettings): number {
  return settings.maxTokens && settings.maxTokens > 0 ? settings.maxTokens : 4096
}

/** 把 settings.model（`<id>/<model>` 或裸字符串）解析成选中项。 */
export function resolveModelSelection(settings: ResolvedSettings): ModelSelection {
  const raw = settings.model
  if (!raw) return { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODEL }
  const slash = raw.indexOf('/')
  if (slash === -1) return { providerId: DEFAULT_PROVIDER_ID, model: raw }
  return { providerId: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

/** key 来源：ZUSE_API_KEY_<ID>（id 大写）优先，其次字面量。 */
function resolveApiKey(providerId: string, literal: string | undefined): string {
  const envKey = process.env[`ZUSE_API_KEY_${providerId.toUpperCase()}`]
  return envKey || literal || ''
}

/**
 * 取某个 provider 的完整配置。
 * - 'default' 且 registry 无该 id：从扁平 model/baseURL/apiKey 合成一个 anthropic provider（向后兼容）。
 * - 否则查 registry；protocol 缺省 anthropic。
 * 缺 key 抛出指明 provider 的错误（占位 key 因非空而合法）。
 */
export function getProviderConfig(settings: ResolvedSettings, providerId: string): ProviderConfig {
  const raw = settings.providers[providerId]

  if (!raw) {
    if (providerId === DEFAULT_PROVIDER_ID) {
      // default 的 key 既可由 mergeLayers 注入的 ZUSE_API_KEY 经 settings.apiKey 提供，
      // 也接受 ZUSE_API_KEY_DEFAULT（resolveApiKey 的通用规则）；错误信息只提示更常用的 ZUSE_API_KEY。
      const apiKey = resolveApiKey(providerId, settings.apiKey)
      if (!apiKey) {
        throw new Error(
          'API key not found for provider "default". Set "apiKey" in settings.local.json, ' +
          'define a "providers" entry, or export ZUSE_API_KEY.',
        )
      }
      return {
        id: DEFAULT_PROVIDER_ID,
        protocol: 'anthropic',
        baseURL: settings.baseURL,
        apiKey,
        // 用 resolveModelSelection 取「裸模型名」：即便 settings.model 误写成 "default/xxx"
        // （旧版 --save 的遗留），也只把 xxx 放进列表，避免 /model 列出 "default/default/xxx"。
        models: settings.model ? [resolveModelSelection(settings).model] : [],
      }
    }
    throw new Error(`Provider "${providerId}" is not configured in settings.providers.`)
  }

  const apiKey = resolveApiKey(providerId, raw.apiKey)
  if (!apiKey) {
    throw new Error(
      `API key not found for provider "${providerId}". Set its "apiKey" in settings.local.json ` +
      `or export ZUSE_API_KEY_${providerId.toUpperCase()}.`,
    )
  }
  return {
    id: providerId,
    protocol: raw.protocol ?? 'anthropic',
    baseURL: raw.baseURL,
    apiKey,
    models: raw.models ?? [],
  }
}

/**
 * 把顶层 `model` 写入本地层 settings.local.json，保留注释与格式（jsonc）。
 * 文件/目录不存在则创建。只改 model 一处。
 * @param localPath 省略时取 <项目根>/.zuse/settings.local.json
 */
export function setModelInSettings(model: string, localPath?: string): void {
  const basePath = localPath ?? join(findProjectRoot(), '.zuse', 'settings.local.json')
  // 已存在 .jsonc 版本就地写它，避免出现两个配置文件。
  const path = resolveLayerPath(basePath)
  // 以原文为基底（缺失/空/读不动都退回 "{}"），保留用户的注释和格式。
  let text = '{}'
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8')
      if (raw.trim()) text = raw
    } catch {
      text = '{}' // 读不动就当空对象重建
    }
  }
  // 只改 model 这一处，applyEdits 保留其余字段、注释与缩进。
  const edits = modify(text, ['model'], model, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const updated = applyEdits(text, edits)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, updated.endsWith('\n') ? updated : updated + '\n', 'utf8')
}

/** 从 settings 解析选中项 + provider 配置，造出对应 client。TUI 启动入口。 */
export function createClientFromSettings(settings: ResolvedSettings): ModelClient {
  const sel = resolveModelSelection(settings)
  return createModelClient(getProviderConfig(settings, sel.providerId), sel.model)
}

/** WebSearch 每次返回条数的默认上限。 */
const DEFAULT_MAX_RESULTS = 5

/**
 * 解析 webSearch 配置：逐后端取字面量 key，只保留有 key 的后端。
 * key 只来自 settings（settings.local.jsonc 等三层），不读环境变量。
 * 无 webSearch 块、或没有任何可用 key → 返回 null（调用方据此不注册 WebSearch 工具，
 * 避免把一个一定失败的工具暴露给模型）。
 * backend 缺省取第一个有 key 的后端；若显式 backend 没 key，也回落到第一个有 key 的。
 */
export function getWebSearchConfig(settings: ResolvedSettings): WebSearchConfig | null {
  const raw = settings.webSearch
  if (!raw) return null
  const backends: Record<string, { apiKey: string }> = {}
  for (const [name, cfg] of Object.entries(raw.backends ?? {})) {
    const apiKey = cfg?.apiKey ?? ''
    if (apiKey) backends[name] = { apiKey }
  }
  const names = Object.keys(backends)
  if (names.length === 0) return null
  const backend = raw.backend && backends[raw.backend] ? raw.backend : names[0]!
  const maxResults = raw.maxResults && raw.maxResults > 0 ? raw.maxResults : DEFAULT_MAX_RESULTS
  return { backend, fallback: raw.fallback ?? [], maxResults, backends }
}
