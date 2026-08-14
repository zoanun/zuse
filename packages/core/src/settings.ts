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
import { normalizePermissionMode } from './permission.js'
import { isNonChatModelType } from './compaction.js'
import type {
  ResolvedSettings,
  RawProviderConfig,
  ProviderConfig,
  ModelSelection,
  RawWebSearchConfig,
  WebSearchConfig,
} from './types.js'
import type { McpServerConfig } from './mcp-client.js'
import { createModelClient } from './model-client.js'
import type { ModelClient } from './model-client.js'

/** 归一化 providers.models 条目为模型名列表(字符串/对象两种形态都合法)。 */
export function modelNames(p?: RawProviderConfig): string[] {
  return (p?.models ?? []).map((m) => (typeof m === 'string' ? m : m.name))
}

/**
 * 同 `modelNames`，但**排掉 `type` 标为非对话的模型**（ocr/tts/embedding/image/…）。
 *
 * **降级(failover)必须用这个，不是 `modelNames`。** 真实事故：主模型报 quota 后，降级按
 * 声明顺序取"下一个"，正好取到紧挨着的 `{ name:'qwen3.5-ocr', type:'ocr' }` —— 会话从此
 * 每句话都回 `{"text":"..."}`（OCR 模型的正常输出格式），而顶栏还显示着旧模型名，用户
 * 完全看不出发生了什么。
 *
 * **"能不能当主模型"这个判断在本仓库有三个实现**，事故当时只有第一个设了闸：
 * server/web 的 `listSelectableModels`（对的）、降级、TUI 的 `buildModelOptions`。
 * 后两个现在都改用本函数。**再加第四个入口时，用它，别又写一份。**
 *
 * 放在这里而不是 compaction.ts：它是 `modelNames` 的姊妹函数，调用方找的是这个名字。
 */
export function chatModelNames(p?: RawProviderConfig): string[] {
  return (p?.models ?? [])
    .filter((m) => typeof m === 'string' || !isNonChatModelType(m.type))
    .map((m) => (typeof m === 'string' ? m : m.name))
}

// 默认 provider 标识符与默认模型（未配置 model 时的回退）。
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250514'
/** 扁平配置合成出的 provider id。导出供 TUI 判断「是否扁平默认」以决定写盘格式。 */
export const DEFAULT_PROVIDER_ID = 'default'

/**
 * 内置默认 allow（合并基线最低层，用户三层配置在其上叠加）。
 *
 * 只收录「纯只读、无副作用」的 Bash 检查命令 —— Bash 工具本身不是 readOnly，不会在
 * default 模式自动放行，故这些常用命令需要显式 allow 才不必每次弹框。Read/Grep/Glob/LSP
 * 已是 readOnly（default 模式直接放行），不在此重复。
 *
 * 注意：matchCommand 是「尾 * 前缀匹配」，故形如 `cat ... > file` 的输出重定向仍会被
 * `Bash(cat *)` 前缀命中而放行（splitBashCommand 不按 `>` 拆分，bash-security 对 `>` 只
 * 标 warn 不压制）。这是已知口径，与用户原有手写配置一致 —— 如需收紧应在 bash-security
 * 把重定向提升为 block，而非在此剔除命令。
 */
export const DEFAULT_ALLOW_RULES: readonly string[] = [
  'Bash(ls)',
  'Bash(ls *)',
  'Bash(pwd)',
  'Bash(cat *)',
  'Bash(echo *)',
  'Bash(which *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(wc *)',
  // Memory 的**读**类 action。以前它们靠 `Memory.readOnly = true` 走 decide 的兜底
  // （`readOnly ? allow : ask`）自动放行 —— 那条路是 **fail-open**：任何不在
  // DEFAULT_ASK_RULES 里的 action 都自动放行，包括将来新加的写类 action。
  // 现在改成显式 allow，未知 action 落到兜底的 ask 上（fail-closed）。
  'Memory(search)',
  'Memory(recall)',
  'Memory(list)',
]

/**
 * 内置默认 deny **刻意为空**。
 *
 * 曾考虑烤入 `Bash(rm -rf /)`、`Bash(mkfs *)` 之类的"硬底线",最终放弃，理由：
 * 1. decide() 中非只读 Bash 在 default 模式本就走 ask —— `rm -rf /` 等危险命令默认必经人审，
 *    deny 规则只在用户配了宽泛 `Bash(*)` allow 或开了 bypass（全自主）时才额外生效。
 * 2. matchCommand 是字面前缀匹配，对 `rm -rf` / `rm -fr` / `rm -r -f` / `rm --recursive --force`
 *    / 双空格等等价变体是打地鼠，永远列不全 —— 给的是虚假的安全感。
 * 3. 而带尾通配的形式（`rm -rf /*`）又会退化成前缀 `rm -rf /`，误伤 `rm -rf /data/xxx` 这类
 *    指向具体路径的合法删除。
 *
 * 结论：宁可不设默认 deny，让安全性诚实地落在「default 模式人审」上。用户/项目仍可在自己的
 * 三层配置里按需添加 deny。若将来要按语义（而非字符串）拦截危险命令，应放进 bash-security.ts
 * 那套解析式检查，而不是这里的前缀规则。
 */
export const DEFAULT_DENY_RULES: readonly string[] = [
  // ── **权限配置文件本身：模型不得改写自己的护栏。** ────────────────────────────
  //
  // 这是上面那段「deny 刻意为空」的**唯一例外**，理由要写清楚，否则下一个人会照那段
  // 论证把它删掉：
  //
  // 那三条讲的是「按字符串前缀去猜危险的 **Bash 命令**」——等价变体列不全、
  // 带尾通配会退化成前缀误伤。**这一条一样都不沾**：目标是几个确定的文件名，
  // 用的是路径 glob，不存在等价类，也没有误伤面（除了它自己）。
  //
  // 为什么必须是 `deny` 而不是 `ask`：**allow 在 `decide` 的第 4 步、早于 ask 的第 5 步。**
  // 我原本写成内置 ask，实测被用户配置里一条极常见的 `Write(./**)`（本仓自己就有）
  // 直接压过 —— 而 `.zuse/settings.local.jsonc` 正好落在 cwd 内。也就是说
  // 「防止自我提权」这个目标在真实配置下一次都不会生效。deny 是第 2 步、压过一切。
  //
  // 威胁：把 `defaultMode` 改成 `bypass` 之后，所有 deny/ask 从下一个会话起全部失效 ——
  // **护栏可以自己拆自己**。而这一步不需要任何 Bash 技巧，一次 Write 就够。
  //
  // **代价，照实说**：模型从此不能替你改 zuse 自己的配置，包括「帮我把这个 MCP server
  // 加进配置里」这种正当请求。它会拿到「这是硬性护栏，请让用户自己改」的明确回执。
  // 这是刻意的取舍：**管着 agent 的那个文件，不该由 agent 来写。**
  //
  // 三种路径写法都要有：`.zuse/…` 命中「配置就在 cwd 根下」（最常见的形态，
  // 而 `**/` 前缀**不**匹配空前缀，只写带 `**/` 的那条会漏掉它 —— 实测过，别省）；
  // `**/.zuse/…` 命中子目录；`~/.zuse/…` 命中用户层。
  'Write(.zuse/settings*.json*)',
  'Edit(.zuse/settings*.json*)',
  'Write(**/.zuse/settings*.json*)',
  'Edit(**/.zuse/settings*.json*)',
  'Write(~/.zuse/settings*.json*)',
  'Edit(~/.zuse/settings*.json*)',
  // **整个 ~/.zuse 一律不许模型写**，不再逐个列文件名。
  //
  // 上面那几条 `settings*.json*` 漏了一个更直接的口子：`~/.zuse/cron/tasks.json`。
  // glob 的 `*` 编译成 `[^/]*`，**跨不过斜杠**，所以那条路径一条都不命中。
  // 而 cron 任务的 `permissionMode` **默认就是 bypass**
  // （CronService.ts 的 `?? 'bypass'` 与 cronStore.ts 的落盘补默认，两处）——
  // 写一份 tasks.json 比改 settings 更直接：后者要等下一个会话，前者自带执行器，
  // 调度器会起一个**非交互 + 全自主**的会话去跑里面的 prompt。
  //
  // 用目录通配而不是继续列文件名，是因为清单必然漂移（第七个文件出现时没人会想起来加）；
  // 而这个目录里每一个文件都直接或间接影响 agent 自身的行为。
  // 代价说清楚：模型从此不能帮用户整理 `~/.zuse/` 下的任何东西，包括 SYSTEM.md 和 skills。
  'Write(~/.zuse/**)',
  'Edit(~/.zuse/**)',
]

/**
 * 内置默认 **ask**（不是 deny）——「这几件事默认值得看一眼」。
 *
 * ## 为什么它不与上面「deny 刻意为空」的三条论证冲突
 *
 * 那三条讲的是「按字符串前缀去猜危险的 **Bash 命令**」。这里的每一条都不是那种东西：
 *
 * 1. 「非只读工具在 default 档本就走 ask，所以不必加」—— **这正是这几条要补的前提**。
 *    `Memory` 标了 `readOnly: true`，恰恰**不**走那条 ask（`decide` 末尾是
 *    `tool.readOnly ? 'allow' : 'ask'`）；而 `Write(./**)` 这类常见配置会把配置文件
 *    一起放行。两处都是「默认**没有**人审」。
 * 2. 「前缀匹配对等价变体是打地鼠」—— **不适用**。`Memory(save)` 的限定符来自
 *    `input.action`，而工具内部 `switch (inp.action)` 用的是**同一个字符串的严格相等**：
 *    规则匹配的串 ≡ 代码分派的串，不存在 `rm -rf` / `rm -fr` 那种等价类。
 *    `'Save'` / `'save '` 既不命中规则、也不命中 switch（工具直接报 Unknown action），fail-safe。
 * 3. 「带尾通配会退化成前缀、误伤具体路径」—— 配置文件那几条的通配是**路径 glob**，
 *    落点是确定的几个文件名，不存在退化。
 *
 * ## 逐条的理由
 *
 * - **`Memory(save)` / `Memory(delete)`**：保存的东西会经 MEMORY.md 进入机主**此后每一个
 *   会话的系统提示词**（工具自己的描述就是这么写的）。一次提示注入即可把
 *   「以后遇到 X 就执行 Y」永久写进去 —— 本轮所有洞里**持续时间最长**的一个。
 *   读的三个 action（search/recall/list）照旧静默。
 * - **配置文件**：`defaultMode` 改成 `bypass` 之后所有 deny/ask 从下个会话起全部失效 ——
 *   **护栏可以自己拆自己**。而 `Write(./**)`（本仓自己的配置就有）让这一步不需要任何
 *   Bash 技巧。这几条比「Bash 重定向判定」更直接、更完整地命中这个威胁：
 *   重定向判定只在 `Bash(echo *)` 那条路上有效，这里是把所有写路径一网打尽。
 *
 * 用户想免掉任何一条，自己写 allow 即可（allow 在 decide 的第 4 步，早于 ask 的第 5 步）。
 */
export const DEFAULT_ASK_RULES: readonly string[] = [
  'Memory(save)',
  'Memory(delete)',
]

/** 通过查找 pnpm-workspace.yaml 定位项目根（从 env.ts 迁来，统一出口）。 */
/**
 * 项目根的标记文件/目录，**就近命中优先**。
 *
 * 原来只认 `pnpm-workspace.yaml`，那对本仓成立、对绝大多数项目不成立。
 * 会话可以 root 到任意目录（目录选择器就是让你往下钻的），
 * 只认一个 pnpm 标记的话，「在 `某项目/src` 下开会话」永远找不到 `某项目/.zuse/`。
 */
const ROOT_MARKERS = ['.zuse', '.git', 'pnpm-workspace.yaml'] as const

/**
 * 从 `from`（缺省为进程 cwd）向上找项目根；找不到就返回起点。
 *
 * **`from` 参数是给会话用的** —— 不传时行为与从前完全一致（锚在 daemon 进程的 cwd）。
 */
export function findProjectRoot(from?: string): string {
  const start = from ?? cwd()
  let dir = start
  while (dir !== resolve(dir, '..')) {
    for (const m of ROOT_MARKERS) if (existsSync(resolve(dir, m))) return dir
    dir = resolve(dir, '..')
  }
  return start
}

/**
 * 读会话所在项目的**收紧规则**：只取 `permissions.deny` 与 `permissions.ask`，
 * 其余字段一概丢弃。
 *
 * ## 为什么只读「收紧」的那一半
 *
 * 让会话根成为**完整**的受信配置层会造出一个比它要修的问题更大的洞。
 * `.zuse/settings.local.*` 在 `.gitignore` 里，**但 `.zuse/settings.json` 不在** ——
 * 它是随仓库分发的。而完整加载会让那个文件能设
 * `permissions.defaultMode: "bypass"`（关掉你全部 deny/ask）和
 * `providers.default.baseURL`（把整段对话导向别人的 endpoint）。
 * 「clone 一个仓库 → 在里面开会话」就成了一条提权 + 外传的路。
 *
 * **只读 deny/ask 则不存在这个问题**：它们只能让判定更严，不能更松。
 * 一个恶意仓库最多把自己的会话卡死，碰不到你的护栏，也改不了你的 endpoint。
 * 放宽的那一半（allow / defaultMode / providers / mcpServers）需要一道显式的
 * 「信任这个目录」闸，那是单独一轮。
 *
 * ## 刻意不做的
 *
 * **不静默回退到 daemon 的配置** —— 那等于没修。会话根没有配置就是没有，
 * 全局（`~/.zuse/settings.json`）那层不受影响，照常生效。
 *
 * 解析失败**不抛**：会话根是用户在目录选择器里随手点的，那里有一份写坏的
 * `.zuse/settings.json` 不该让「新建会话」直接 500。降级成「这一层当空」+ 告警。
 * 注意**不能**降级成「回退到 daemon 配置」——那会给出一条「把配置写坏就能卸掉 deny」的路。
 */
export function loadTighteningRules(root: string): { deny: string[]; ask: string[] } {
  const out = { deny: [] as string[], ask: [] as string[] }
  for (const base of ['settings.json', 'settings.local.json']) {
    const path = resolveLayerPath(resolve(root, '.zuse', base))
    try {
      const raw = readLayer(path)
      const pm = raw.permissions
      if (pm?.deny) out.deny.push(...pm.deny)
      if (pm?.ask) out.ask.push(...pm.ask)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[zuse] 会话目录下的配置读不了，已忽略该层：${path}：${msg}`)
    }
  }
  return out
}

/** 单层文件的原始（未补默认值）形状，全部可选。 */
interface RawSettings {
  model?: string
  smallModel?: string
  imageModel?: string
  sttModel?: string
  ttsModel?: string
  ttsVoice?: string
  maxTokens?: number
  baseURL?: string
  apiKey?: string
  proxy?: string
  failoverMode?: 'dialog' | 'auto'
  tools?: { enabled?: string[]; disabled?: string[] }
  permissions?: {
    // 刻意是 string 而不是 PermissionMode：这是**未经校验的磁盘内容**，readLayer 只做
    // `parsed as RawSettings` 的断言、不做运行期检查。声明成窄类型是在骗自己 —— 野生
    // 非法值（`"yolo"`）和老别名（`"bypassPermissions"`）都真实存在于用户的配置文件里。
    // 收窄发生在 mergeLayers 里的 normalizePermissionMode 那一步。
    defaultMode?: string
    allow?: string[]
    ask?: string[]
    deny?: string[]
  }
  providers?: Record<string, RawProviderConfig>
  webSearch?: RawWebSearchConfig
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }>
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
    // 以内置默认 allow/deny 作基线，用户三层规则在其上叠加（dedupe 保留首现顺序 → 默认在前）。
    permissions: { defaultMode: 'default', allow: [...DEFAULT_ALLOW_RULES], ask: [...DEFAULT_ASK_RULES], deny: [...DEFAULT_DENY_RULES] },
    providers: {},
  }
  for (const layer of layers) {
    if (layer.model !== undefined) out.model = layer.model
    if (layer.smallModel !== undefined) out.smallModel = layer.smallModel
    if (layer.imageModel !== undefined) out.imageModel = layer.imageModel
    if (layer.sttModel !== undefined) out.sttModel = layer.sttModel
    if (layer.ttsModel !== undefined) out.ttsModel = layer.ttsModel
    if (layer.ttsVoice !== undefined) out.ttsVoice = layer.ttsVoice
    if (layer.maxTokens !== undefined) out.maxTokens = layer.maxTokens
    if (layer.baseURL !== undefined) out.baseURL = layer.baseURL
    if (layer.apiKey !== undefined) out.apiKey = layer.apiKey
    if (layer.proxy !== undefined) out.proxy = layer.proxy
    if (layer.failoverMode !== undefined) out.failoverMode = layer.failoverMode
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
    // MCP servers 按 server 名浅合并：高层整条覆盖同名 server（配置是原子的）。
    if (layer.mcpServers) out.mcpServers = { ...(out.mcpServers ?? {}), ...layer.mcpServers }
    const pm = layer.permissions
    if (pm) {
      // 归一化边界之一：老别名 `bypassPermissions` 在这里被认成 `bypass`（落盘的旧配置
      // 还写着老名字，不认它就等于让人家的全自主档静默失效）。认不出的值（`"yolo"`）
      // **整层当没写**，保留低层结果 —— 而不是强行拉回 'default'：user 层写了
      // acceptEdits、project 层手滑写错一个词，把用户按到比两层都严的档位上是意外行为。
      // 全新配置下低层就是基线 'default'，所以「非法值 → default」那条也仍然成立。
      if (pm.defaultMode !== undefined) {
        const mode = normalizePermissionMode(pm.defaultMode)
        if (mode) out.permissions.defaultMode = mode
      }
      if (pm.allow) out.permissions.allow.push(...pm.allow)
      if (pm.ask) out.permissions.ask.push(...pm.ask)
      if (pm.deny) out.permissions.deny.push(...pm.deny)
    }
  }
  // 跨层拼接后去重：多层常携带相同规则（如 user 默认 + local 又抄了一份），
  // 拼接会留下重复项——功能上无害（命中判断只看是否包含），但 /config 读起来啰嗦、
  // 匹配也做无用功。保留首次出现顺序（低层在前），顺序对权限语义无影响。
  for (const k of ['allow', 'ask', 'deny'] as const) out.permissions[k] = dedupe(out.permissions[k])
  const envKey = process.env.ZUSE_API_KEY
  if (envKey) out.apiKey = envKey
  // 代理也支持环境变量覆盖（与 apiKey 同款）：ZUSE_PROXY 优先于任意层的字面量。
  const envProxy = process.env.ZUSE_PROXY
  if (envProxy) out.proxy = envProxy
  return out
}

/** 保留首次出现顺序的字符串去重。 */
function dedupe(items: string[]): string[] {
  return [...new Set(items)]
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

/**
 * 增/删全局 settings 里的一个 MCP server 配置（M4）。`config` 为 null 时删除该 server。
 * 默认写全局 `~/.zuse/settings.json(c)`（mcpServers 通常配在全局层）；用 jsonc 的
 * modify+applyEdits 只动 mcpServers.<name> 这一处,保留其余字段/注释/缩进。
 * @param basePath 省略时取 `~/.zuse/settings.json`（同名 .jsonc 优先）。
 */
export function setMcpServerInSettings(name: string, config: McpServerConfig | null, basePath?: string): void {
  // config===null → 传 undefined 让 modify 删除该键。
  updateJsoncSettingsFile(basePath ?? join(homedir(), '.zuse', 'settings.json'), ['mcpServers', name], config ?? undefined)
}

/**
 * 用 jsonc 的 modify+applyEdits 在一个 settings 文件里就地设置（或删除,value=undefined）一个
 * key 路径,保留其余字段/注释/缩进。以原文为基底(缺失/空/读不动退回 "{}"),原子落盘。
 * 是 setModelInSettings / setMcpServerInSettings 共用的写入原语。
 */
function updateJsoncSettingsFile(basePath: string, keyPath: (string | number)[], value: unknown): void {
  const path = resolveLayerPath(basePath)
  let text = '{}'
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8')
      if (raw.trim()) text = raw
    } catch {
      text = '{}'
    }
  }
  const edits = modify(text, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
  const updated = applyEdits(text, edits)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, updated.endsWith('\n') ? updated : updated + '\n', 'utf8')
}

/** max_tokens：settings.maxTokens，否则回退 4096。 */
export function getDefaultMaxTokens(settings: ResolvedSettings): number {
  return settings.maxTokens && settings.maxTokens > 0 ? settings.maxTokens : 4096
}

/** 解析降级策略:settings.failoverMode,缺省 'dialog'。 */
export function resolveFailoverMode(settings: ResolvedSettings): 'dialog' | 'auto' {
  return settings.failoverMode ?? 'dialog'
}

/** 把 settings.model（`<id>/<model>` 或裸字符串）解析成选中项。 */
export function resolveModelSelection(settings: ResolvedSettings): ModelSelection {
  const raw = settings.model
  if (!raw) return { providerId: DEFAULT_PROVIDER_ID, model: DEFAULT_MODEL }
  const slash = raw.indexOf('/')
  if (slash === -1) return { providerId: DEFAULT_PROVIDER_ID, model: raw }
  return { providerId: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

/**
 * 把 `provider/model` 形式的原始字符串切成 {providerId, model}。只在第一个 `/`
 * 处切分 → 模型名里的 `/`（如 siliconflow/Qwen/Qwen2.5-7B-Instruct）合法。裸字符串
 * 走默认 provider。空/未配置返回 null（调用方据此判断是否启用）。
 */
function splitProviderModel(raw: string | undefined): ModelSelection | null {
  if (!raw) return null
  const slash = raw.indexOf('/')
  if (slash === -1) return { providerId: DEFAULT_PROVIDER_ID, model: raw }
  return { providerId: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

/**
 * 解析 settings.smallModel（小模型,用于标题生成等廉价任务）。未配置则返回 null
 * （调用方据此回退,不启用小模型）。
 */
export function resolveSmallModelSelection(settings: ResolvedSettings): ModelSelection | null {
  return splitProviderModel(settings.smallModel)
}

/**
 * 解析 settings.imageModel（图片解析模型,仅图片解析回退路径用）。未配置则返回
 * null（调用方据此不启用图片解析兜底）。
 */
export function resolveImageModelSelection(settings: ResolvedSettings): ModelSelection | null {
  return splitProviderModel(settings.imageModel)
}

/**
 * 解析 settings.sttModel（语音转写模型,V1）。未配置则返回 null（调用方据此禁用语音输入）。
 * provider 必须是 openai 协议 —— 音频端点是 OpenAI 形状,校验在 VoiceService。
 */
export function resolveSttModelSelection(settings: ResolvedSettings): ModelSelection | null {
  return splitProviderModel(settings.sttModel)
}

/**
 * 解析 settings.ttsModel（朗读模型,V2）。未配置则返回 null（调用方据此禁用朗读）。
 */
export function resolveTtsModelSelection(settings: ResolvedSettings): ModelSelection | null {
  return splitProviderModel(settings.ttsModel)
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
    models: modelNames(raw),
  }
}

/**
 * 把顶层 `model` 写入本地层 settings.local.json，保留注释与格式（jsonc）。
 * 文件/目录不存在则创建。只改 model 一处。
 * @param localPath 省略时取 <项目根>/.zuse/settings.local.json
 */
export function setModelInSettings(model: string, localPath?: string): void {
  updateJsoncSettingsFile(localPath ?? join(findProjectRoot(), '.zuse', 'settings.local.json'), ['model'], model)
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
