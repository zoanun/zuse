import { isAbsolute, resolve, relative, sep } from 'node:path'
import type { Tool } from './tool.js'
import type { ResolvedSettings, PermissionDecision } from './types.js'
import { hasBlockingBashSecurityIssue } from './bash-security.js'

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

/**
 * 把一条 Bash 命令按顶层控制操作符（&& || ; | 换行）拆成多个子命令。
 * 引号内的操作符不拆（`echo "a | b"` 仍是一条）。这是权限校验的安全核心：
 * 不拆分时,前缀 allow 规则 `Bash(git status*)` 会把 `git status && rm -rf ~`
 * 整条放行 —— 因为整条确实以 "git status" 开头。逐子命令校验后,危险的 `rm`
 * 子命令没有 allow 规则覆盖,整条便不再自动放行。
 *
 * 裸 `&`(后台执行)同样是顶层命令分隔符：`a & rm -rf /` 会把 `a` 丢后台再跑 `rm`,
 * 故必须拆,否则危险子命令整条逃过逐子命令校验(deny/allow 都看不见它)。但重定向里
 * 的 `&` 不拆 —— `2>&1` / `>&2`(前一字符是 `>`/`<`)、`&>file`(后一字符是 `>`)。
 * 这是尽力而为的词法拆分,不处理转义/命令替换 —— 后者由 hasUnanalyzableShell 兜底。
 */
export function splitBashCommand(command: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === '\n' || c === ';') {
      parts.push(cur)
      cur = ''
      continue
    }
    if (c === '&') {
      // `&&` 逻辑与：拆,跳过第二个 &
      if (command[i + 1] === '&') {
        parts.push(cur)
        cur = ''
        i++
        continue
      }
      // 重定向里的 & 不拆：2>&1 / >&2（前一字符是 > 或 <）、&>file（后一字符是 >）
      if (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>') {
        cur += c
        continue
      }
      // 裸 &（后台执行）：也是顶层分隔符,按它拆
      parts.push(cur)
      cur = ''
      continue
    }
    if (c === '|' && command[i + 1] === '|') {
      parts.push(cur)
      cur = ''
      i++
      continue
    }
    if (c === '|') {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  parts.push(cur)
  return parts.map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * 命令是否含无法静态拆分的构造：命令替换 `$(...)` 或反引号。这类命令可能把任意
 * 命令藏在替换里（`echo $(rm -rf x)`）,逐子命令拆分看不见。命中时禁用"逐子命令
 * 自动放行",强制走 ask（除非有人显式按整条精确放行）。${VAR} 只是变量展开,不算。
 */
function hasUnanalyzableShell(command: string): boolean {
  return /\$\(/.test(command) || command.includes('`')
}

/**
 * Bash 命令是否被一组规则"完整覆盖"：要么有规则精确命中整条命令（会话覆盖层
 * allow_session 追加的就是整条精确规则,以及用户写的整条精确 allow）,要么每个
 * 子命令都被某条规则前缀/精确命中。含命令替换时不走逐子命令路径（见
 * hasUnanalyzableShell）。
 */
function bashCoveredBy(rules: string[], command: string, subs: string[], cwd: string): boolean {
  const wholeExact = rules.some((r) => {
    const p = parseRule(r)
    return p !== null && p.tool === 'Bash' && p.specifier !== null && p.specifier === command
  })
  if (wholeExact) return true
  if (hasUnanalyzableShell(command)) return false
  return subs.length > 0 && subs.every((s) => rules.some((r) => matchesRule(r, 'Bash', s, cwd)))
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
): { decision: PermissionDecision; rule: string; matched?: string; reason?: string } {
  const name = tool.name
  const rule = buildRule(name, specifier)

  // Bash 复合命令逐子命令校验：整条只前缀匹配会被 `safe && evil` 绕过。
  // 子命令列表供 deny/allow/ask 逐条比对；非 Bash 工具按整条 specifier 比对。
  const isBash = name === 'Bash' && specifier !== null
  const subs = isBash ? splitBashCommand(specifier!) : []
  const denyHit = (r: string): boolean =>
    isBash
      ? matchesRule(r, name, specifier, cwd) || subs.some((s) => matchesRule(r, name, s, cwd))
      : matchesRule(r, name, specifier, cwd)
  const askHit = denyHit // ask 与 deny 同样"任一子命令命中即算命中"

  // 1. 工具暴露开关：被禁 → deny（既不暴露也兜底拦截）。
  const { enabled, disabled } = settings.tools
  if (enabled && !enabled.includes(name)) return { decision: 'deny', rule, matched: 'tools.enabled' }
  if (disabled && disabled.includes(name)) return { decision: 'deny', rule, matched: 'tools.disabled' }

  const perms = settings.permissions

  // 2. deny 永远最高优先。Bash 任一子命令命中 deny 即整条拒绝。
  for (const r of perms.deny) {
    if (denyHit(r)) return { decision: 'deny', rule, matched: r }
  }

  // 3. bypassPermissions 模式直接放行（deny 已在上面检查过）。
  if (perms.defaultMode === 'bypassPermissions') return { decision: 'allow', rule }

  // 3.5 Bash 安全检查（23 项的 block 档）：把混淆/注入/解析歧义模式压过 allow，强制人审。
  // 优先级低于 deny / bypass（上方已返回），高于 allow —— 即便有前缀 allow 规则覆盖，
  // 命中 block 也不自动放行。词法拆分看不见的引号花招、进程替换、$IFS、回车符等在此兜底。
  if (isBash) {
    const sec = hasBlockingBashSecurityIssue(specifier!)
    if (sec) return { decision: 'ask', rule, matched: `security:${sec.checkId} ${sec.name}`, reason: sec.reason }
  }

  // 4. allow（含会话覆盖层）。Bash 需整条被规则"完整覆盖"才放行。
  const allowRules = [...perms.allow, ...sessionAllow]
  if (isBash) {
    if (bashCoveredBy(allowRules, specifier!, subs, cwd)) return { decision: 'allow', rule }
  } else {
    for (const r of allowRules) {
      if (matchesRule(r, name, specifier, cwd)) return { decision: 'allow', rule, matched: r }
    }
  }

  // 5. ask 规则命中 → 要求确认。
  for (const r of perms.ask) {
    if (askHit(r)) return { decision: 'ask', rule, matched: r }
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
