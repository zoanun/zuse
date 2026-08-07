import { resolve, relative, sep } from 'node:path'
import { homedir } from 'node:os'
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

/** 一组规则里是否有「整条精确放行」该命令的规则（allow_session 追加的整条规则,或用户手写的整条精确 allow）。 */
function hasWholeExactBashAllow(rules: string[], command: string): boolean {
  return rules.some((r) => {
    const p = parseRule(r)
    return p !== null && p.tool === 'Bash' && p.specifier !== null && p.specifier === command
  })
}

/**
 * Bash 命令是否被一组规则"完整覆盖"：要么有规则精确命中整条命令（会话覆盖层
 * allow_session 追加的就是整条精确规则,以及用户写的整条精确 allow）,要么每个
 * 子命令都被某条规则前缀/精确命中。含命令替换时不走逐子命令路径（见
 * hasUnanalyzableShell）。
 */
function bashCoveredBy(rules: string[], command: string, subs: string[], cwd: string): boolean {
  if (hasWholeExactBashAllow(rules, command)) return true
  if (hasUnanalyzableShell(command)) return false
  return subs.length > 0 && subs.every((s) => rules.some((r) => matchesRule(r, 'Bash', s, cwd)))
}

/** 把 glob 转成锚定正则。支持 `**`（含 /）、`*`（不含 /）、`?`；其余字符转义。 */
function globToRegExp(glob: string, flags = ''): RegExp {
  // 去掉前导 ./
  const g0 = glob.replace(/^\.\//, '')
  // 末尾的 `/**` 连同它前面那个 `/` 一起变成可选：`src/**` 既匹配 `src/a.ts`,也匹配
  // 目录本身 `src`。Grep / Glob 的限定符就是**搜索根**（`Grep(path)` / `Glob(cwd)`），
  // 不这么处理的话 `deny: Grep(~/.ssh/**)` 拦不住「根正好是 ~/.ssh」的那次搜索 ——
  // 恰恰是最直白的那种攻击写法。裸 `**` 不走这条（不以 `/**` 结尾）。
  const dirToo = g0.endsWith('/**')
  const g = dirToo ? g0.slice(0, -3) : g0
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
  if (dirToo) re += '(?:\\/.*)?'
  return new RegExp('^' + re + '$', flags)
}

/** 把系统分隔符统一成 posix `/`（win32 上 `\` → `/`；posix 上无操作，反斜杠是合法文件名字符）。 */
function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/**
 * 「绝对路径形态」判定。刻意**不用** node:path 的 `isAbsolute`：它按当前平台判，
 * posix 上不认 `C:/x`、win32 上不认得同一份配置在 Linux 下的写法 —— 同一份
 * settings.jsonc 会在两个平台上语义分叉。这里对 `/x`、`//host/share`、`C:/x`
 * 一律认作绝对，规则语言与运行平台无关。
 */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:)?\//

/**
 * 文件路径匹配。**按规则（spec）的形态决定比对基准**，而不是一律拿相对路径比：
 *
 * - `~` / `~/…`：展开成家目录后按**绝对路径**比。只展开规则侧,**不展开目标侧** ——
 *   工具真正打开文件走 `resolvePath()`(tool.ts),它同样不展开 `~`,目标 `~/.ssh/x`
 *   实际打开的是 `<cwd>/~/.ssh/x`。权限侧单方面展开会让"判定的路径"和"打开的路径"
 *   对不上,那是新的绕过口子而不是加固。
 * - 绝对规则（`/etc/**`、`C:/foo/**`）：按绝对路径比。此前一律拿 `relative()` 的结果比,
 *   同盘时恒不命中、跨盘时因 `relative()` 返回整条绝对路径才**碰巧**命中 ——
 *   同一条规则的行为取决于盘符。
 * - 其余（cwd 锚定的相对规则，含 `./` 前缀）：拿 `relative(cwd, abs)` 比，
 *   但**目标必须在 cwd 内**。
 *
 * 最后那道围栏是本函数的安全核心，删掉就是一个可以静默读走 SSH 私钥的洞：
 * `./**` 被 globToRegExp 剥掉 `./` 变成 `**`、编译成 `^.*$`，而 `relative()` 对 cwd 外的
 * 目标返回 `../…`（同盘）或整条绝对路径（跨盘），两者统统被 `^.*$` 命中。于是一条
 * 读起来「仅限当前项目」的规则实际放行**整个文件系统**。围栏之外的目标只有绝对/`~`
 * 规则能命中 —— 那是用户明确写出来的路径，不会看走眼。
 *
 * 注：判逃逸必须是 `rel === '..'` 或以 `../` 开头，不能用 `startsWith('..')` ——
 * 后者会把 `..foo/` 这种合法目录名误判成逃逸。
 */
function matchPath(spec: string, rawPath: string, rawCwd: string): boolean {
  // cwd 也 resolve 一遍：调用方目前传的都是绝对路径,但相对 cwd 会让 relative() 静默
  // 回落到 process.cwd(),围栏就锚在了错误的目录上。一行成本换掉一整类难查的错。
  const cwd = resolve(rawCwd)
  // 无条件 resolve（而不是 `isAbsolute(raw) ? raw : resolve(...)`）：resolve 会把
  // `.` / `..` 段规整掉。少了这步，走绝对规则那条分支时 `deny: Read(/etc/passwd)`
  // 能被 `/etc/./passwd` 绕过 —— 相对分支的 relative() 自带规整，绝对分支没有。
  const abs = resolve(cwd, rawPath)

  // Windows 文件系统大小写不敏感（实测 `C:/Users/nhn/.zuse` 与 `c:/users/nhn/.zuse`
  // 是同一个目录），所以路径比对也必须不敏感 —— 否则 `deny: Read(~/.ssh/**)` 只要
  // 模型把路径写成小写就绕过去了,而这条正是本模块推荐的护私钥写法。
  // 只按 `sep` 门控（与下面 `\`→`/` 归一同一套理由）：Linux 确实大小写敏感。
  // 已知缺口：macOS 默认 APFS 也不敏感,但 sep 是 `/` 覆盖不到 —— 那里靠的是
  // 「不敢假设用户的卷是不是 case-sensitive」,宁可漏报也不误放行 allow。
  const flags = sep === '\\' ? 'i' : ''

  // Windows 用户会把规则写成 `C:\foo\**`；现行 glob 编译把 `\` 当字面量转义，
  // 这类写法恒不命中，又是一种静默失效。只在 win32 归一，避免动 posix 上
  // 「反斜杠是合法文件名字符」的语义。
  let s = sep === '\\' ? spec.replace(/\\/g, '/') : spec
  if (s === '~' || s.startsWith('~/')) s = toPosix(homedir()) + s.slice(1)

  if (ABSOLUTE_PATH.test(s)) {
    // win32 上无盘符的 `/secrets/**` 是「盘符相对」路径：node 会把目标 `/secrets/x`
    // 归到 cwd 所在盘（`E:/secrets/x`），规则却还是裸 `/secrets/**` —— 又一条恒不命中的
    // 静默空规则。补上 cwd 的盘符,让规则和工具实际打开的路径落在同一个坐标系里。
    // `//host/share` 这类 UNC 不能补（`//` 开头）。
    if (sep === '\\' && s.startsWith('/') && !s.startsWith('//')) {
      s = (/^[A-Za-z]:/.exec(toPosix(cwd))?.[0] ?? '') + s
    }
    return globToRegExp(s, flags).test(toPosix(abs))
  }

  const rel = toPosix(relative(cwd, abs))
  // 逃出 cwd（`../…` 同盘上跳 / 跨盘时 relative() 直接返回绝对路径）→ cwd 锚定规则一律不命中
  if (rel === '..' || rel.startsWith('../') || ABSOLUTE_PATH.test(rel)) return false
  return globToRegExp(s, flags).test(rel)
}

/**
 * 单条规则是否命中本次调用。
 *
 * @param kind 限定符的性质，取自 `Tool.specifierKind`（缺省 `'path'`）。`'opaque'` 的
 *   限定符（Agent 描述、WebFetch 主机名、LspInstall 语言 id）不是路径，直接按 glob 比字面量：
 *   不 resolve、不相对化、不过 cwd 围栏。走路径那套会让 `Agent(../修接口)` 这种
 *   会话规则匹配不上它自己（见 `Tool.specifierKind` 的说明）。
 */
export function matchesRule(
  rule: string,
  toolName: string,
  specifier: string | null,
  cwd: string,
  kind: 'path' | 'opaque' = 'path',
): boolean {
  const p = parseRule(rule)
  if (!p) return false
  if (p.tool !== toolName) return false
  // 裸规则：匹配该工具任意调用
  if (p.specifier === null) return true
  // 规则要求限定符，但本次没有可比对的内容
  if (specifier === null) return false
  if (toolName === 'Bash') return matchCommand(p.specifier, specifier)
  if (kind === 'opaque') return globToRegExp(p.specifier).test(specifier)
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
  // 该工具的限定符是路径还是不透明文本（Agent 描述 / WebFetch 主机名等），见 Tool.specifierKind
  const kind = tool.specifierKind ?? 'path'

  // Bash 复合命令逐子命令校验：整条只前缀匹配会被 `safe && evil` 绕过。
  // 子命令列表供 deny/allow/ask 逐条比对；非 Bash 工具按整条 specifier 比对。
  const isBash = name === 'Bash' && specifier !== null
  const subs = isBash ? splitBashCommand(specifier!) : []
  const denyHit = (r: string): boolean =>
    isBash
      ? matchesRule(r, name, specifier, cwd) || subs.some((s) => matchesRule(r, name, s, cwd))
      : matchesRule(r, name, specifier, cwd, kind)
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

  // allow 规则集（含会话覆盖层）；3.5 安全闸与第 4 步共用。
  const allowRules = [...perms.allow, ...sessionAllow]

  // 3.5 Bash 安全检查（23 项的 block 档）：把混淆/注入/解析歧义模式压过 allow，强制人审。
  // 优先级低于 deny / bypass（上方已返回），也高于宽泛/前缀 allow（如 Bash(*)）。但用户/会话对
  // 「这一整条命令」的精确放行（allow_session 追加的整条规则,或手写的整条精确 allow）是逐条
  // 明示同意,凌驾于本闸 —— 否则弹框「本会话」对 block 档会静默失效、每次重复询问。首次命中
  // 仍必经人审,通过后方记入会话层；词法拆分看不见的引号花招、进程替换、$IFS、回车符等在此兜底。
  if (isBash && !hasWholeExactBashAllow(allowRules, specifier!)) {
    const sec = hasBlockingBashSecurityIssue(specifier!)
    if (sec) return { decision: 'ask', rule, matched: `security:${sec.checkId} ${sec.name}`, reason: sec.reason }
  }

  // 4. allow（含会话覆盖层）。Bash 需整条被规则"完整覆盖"才放行。allowRules 已在上方构造。
  if (isBash) {
    if (bashCoveredBy(allowRules, specifier!, subs, cwd)) return { decision: 'allow', rule }
  } else {
    for (const r of allowRules) {
      if (matchesRule(r, name, specifier, cwd, kind)) return { decision: 'allow', rule, matched: r }
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
