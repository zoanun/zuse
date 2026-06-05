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
import type { ResolvedSettings, PermissionMode } from './types.js'

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
  tools?: { enabled?: string[]; disabled?: string[] }
  permissions?: {
    defaultMode?: PermissionMode
    allow?: string[]
    ask?: string[]
    deny?: string[]
  }
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
  }
  for (const layer of layers) {
    if (layer.model !== undefined) out.model = layer.model
    if (layer.maxTokens !== undefined) out.maxTokens = layer.maxTokens
    if (layer.baseURL !== undefined) out.baseURL = layer.baseURL
    if (layer.apiKey !== undefined) out.apiKey = layer.apiKey
    if (layer.tools) out.tools = { ...out.tools, ...layer.tools }
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
