import { isAbsolute, resolve, relative, sep } from 'node:path'
import type { Tool } from './tool.js'
import type { ResolvedSettings, PermissionDecision } from './types.js'

/** 由工具名 + 限定符拼出规则字符串。 */
export function buildRule(toolName: string, specifier: string | null): string {
  return specifier === null ? toolName : `${toolName}(${specifier})`
}

/** 解析规则；非法返回 null。`Tool` -> {tool, specifier:null}；`Tool(x)` -> {tool, specifier:'x'}。 */
export function parseRule(rule: string): { tool: string; specifier: string | null } | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) return null
  return { tool: m[1]!, specifier: m[2] === undefined ? null : m[2] }
}

/** Bash 限定符匹配：`*` 全匹配；尾 `*` 前缀匹配；否则精确。 */
function matchCommand(spec: string, command: string): boolean {
  if (spec === '*') return true
  if (spec.endsWith('*')) return command.startsWith(spec.slice(0, -1))
  return command === spec
}

/** 把 glob 转成锚定正则。支持 `**`（含 /）、`*`（不含 /）、`?`；其余字符转义。 */
function globToRegExp(glob: string): RegExp {
  // 去掉前导 ./
  const g = glob.replace(/^\.\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*'
        i++
        // 吃掉 **/ 里的斜杠，使其可匹配零级目录
        if (g[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/** 文件路径匹配：把输入路径规整成相对 cwd 的 posix 形式，再用 glob 比对。 */
function matchPath(spec: string, rawPath: string, cwd: string): boolean {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
  // 统一转为 posix 分隔符
  const rel = relative(cwd, abs).split(sep).join('/')
  return globToRegExp(spec).test(rel)
}

/** 单条规则是否命中本次调用。 */
export function matchesRule(rule: string, toolName: string, specifier: string | null, cwd: string): boolean {
  const p = parseRule(rule)
  if (!p) return false
  if (p.tool !== toolName) return false
  // 裸规则：匹配该工具任意调用
  if (p.specifier === null) return true
  // 规则要求限定符，但本次没有可比对的内容
  if (specifier === null) return false
  if (toolName === 'Bash') return matchCommand(p.specifier, specifier)
  return matchPath(p.specifier, specifier, cwd)
}

/**
 * 权限判定（spec §6.3）。顺序：禁用 → deny → bypass → allow → ask → defaultMode 兜底。
 * @param tool        正在被请求调用的工具。
 * @param specifier   命令（Bash）或文件路径（文件工具）；无则 null。
 * @param settings    已合并的三层设置。
 * @param sessionAllow 本会话内存覆盖层（额外 allow 规则）。
 * @param cwd         当前工作目录，用于路径相对化。
 */
export function decide(
  tool: Tool,
  specifier: string | null,
  settings: ResolvedSettings,
  sessionAllow: string[],
  cwd: string,
): { decision: PermissionDecision; rule: string; matched?: string } {
  const name = tool.name
  const rule = buildRule(name, specifier)

  // 1. 工具暴露开关：被禁 → deny（既不暴露也兜底拦截）。
  const { enabled, disabled } = settings.tools
  if (enabled && !enabled.includes(name)) return { decision: 'deny', rule, matched: 'tools.enabled' }
  if (disabled && disabled.includes(name)) return { decision: 'deny', rule, matched: 'tools.disabled' }

  const perms = settings.permissions

  // 2. deny 永远最高优先。
  for (const r of perms.deny) {
    if (matchesRule(r, name, specifier, cwd)) return { decision: 'deny', rule, matched: r }
  }

  // 3. bypassPermissions 模式直接放行（deny 已在上面检查过）。
  if (perms.defaultMode === 'bypassPermissions') return { decision: 'allow', rule }

  // 4. allow（含会话覆盖层）。
  for (const r of [...perms.allow, ...sessionAllow]) {
    if (matchesRule(r, name, specifier, cwd)) return { decision: 'allow', rule, matched: r }
  }

  // 5. ask 规则命中 → 要求确认。
  for (const r of perms.ask) {
    if (matchesRule(r, name, specifier, cwd)) return { decision: 'ask', rule, matched: r }
  }

  // 6. defaultMode 兜底。
  if (perms.defaultMode === 'acceptEdits') {
    // acceptEdits：编辑类工具（readOnly 或 Edit/Write）自动放行，其余仍需确认。
    if (tool.readOnly || name === 'Edit' || name === 'Write') return { decision: 'allow', rule }
    return { decision: 'ask', rule }
  }

  // 'default'：只读工具自动放行，其余需确认。
  return { decision: tool.readOnly ? 'allow' : 'ask', rule }
}
