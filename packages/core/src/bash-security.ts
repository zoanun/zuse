import { splitBashCommand } from './permission.js'

/**
 * Bash 安全检查（对齐 Claude Code 的「23 项 Bash 安全检查」，源码参考
 * cc-haha/src/tools/BashTool/bashSecurity.ts）。
 *
 * 定位：zuse 的权限闸已用 `splitBashCommand` 把复合命令逐子命令校验，堵住了
 * `allow && evil` 这类「顶层操作符拼接」绕过。但词法拆分**看不见**那些把危险命令
 * 藏进引号/转义/展开/替换里的混淆手法 —— 本模块就专补这一层：在「一条命令本会被
 * allow 规则自动放行」时，识别这些混淆/注入/解析歧义模式并**降级为 ask**（强制人审），
 * 既不静默放行，也不直接 deny（用户仍可当场批准）。deny 与 bypassPermissions 的优先级
 * 都高于本层（见 permission.decide 的顺序）。
 *
 * 严重度分两档：
 * - `block`：高置信的混淆/注入/解析差异模式（引号花招、进程替换、$IFS、/proc/environ、
 *   回车符、控制字符、zsh 危险内建等）。命中即**压过 allow**、强制 ask。误报率极低
 *   —— 正常命令几乎不会用到这些写法。
 * - `warn`：日常合法、但理论上可被滥用的写法（重定向 `>`/`<`、`grep $f | x`、`find … \;`、
 *   花括号展开、换行等）。zuse 的拆分器已能覆盖其中的拼接风险，且这些写法太常见，
 *   若一律压过 allow 会把 `Bash(*)` 这类授权变得无法忍受 —— 故 v1 **仅检测、不压过 allow**，
 *   保留给权限对话框将来作为「风险提示」展示。
 *
 * 之所以不照搬 CC 那 2,592 行：CC 构建在 tree-sitter + shell-quote 解析器之上，且其
 * allowlist 是纯前缀语义、必须靠这一层堵 newline/操作符拼接；zuse 用 splitBashCommand
 * 已在更前面处理了拼接，故这里只保留「拆分器看不见」的那部分，按能力对齐而非逐行复制。
 */

/** 检查严重度。block 压过 allow → 强制 ask；warn 仅检测、不改判定（v1）。 */
export type BashSecuritySeverity = 'block' | 'warn'

/** 一次命中：checkId 对齐 CC 的编号，name 便于日志/测试断言。 */
export interface BashSecurityHit {
  checkId: number
  name: string
  severity: BashSecuritySeverity
  reason: string
}

/**
 * zsh 专属、可绕过常规检查的危险命令/内建（对照命令首词）。zmodload 是一众基于模块的
 * 攻击入口（zsh/system 隐形文件 I/O、zsh/zpty 伪终端执行命令、zsh/net/tcp 外联、
 * zsh/files 绕过二进制检查的内建 rm/mv…）；emulate -c 等价 eval；其余为模块内建，
 * 即便需先 zmodload 也作纵深防御一并拦下。
 */
const ZSH_DANGEROUS_COMMANDS = new Set<string>([
  'zmodload', 'emulate',
  'sysopen', 'sysread', 'syswrite', 'sysseek',
  'zpty', 'ztcp', 'zsocket', 'mapfile',
  'zf_rm', 'zf_mv', 'zf_ln', 'zf_chmod', 'zf_chown', 'zf_mkdir', 'zf_rmdir', 'zf_chgrp',
])

/** 进程替换 / 各类展开的危险写法（不含 `${VAR}` 普通变量展开 —— 与 permission 的口径一致；
 * `$(`/反引号已由 hasUnanalyzableShell 阻止自动放行，这里仍列出 `$(` 作纵深防御，反引号单独处理）。 */
const SUBSTITUTION_PATTERNS: { pattern: RegExp; message: string }[] = [
  { pattern: /<\(/, message: '进程替换 <()' },
  { pattern: />\(/, message: '进程替换 >()' },
  { pattern: /=\(/, message: 'zsh 进程替换 =()' },
  // zsh EQUALS 展开：词首 `=cmd` 会被展开成 `$(which cmd)`，`=curl evil` 即 `/usr/bin/curl evil`，
  // 绕过 Bash(curl:*) 这类规则（解析器把 `=curl` 当命令名）。仅匹配词首 = 后接命令名字符（不碰 VAR=val）。
  { pattern: /(?:^|[\s;&|])=[a-zA-Z_]/, message: 'zsh 等号展开 (=cmd)' },
  { pattern: /\$\(/, message: '$() 命令替换' },
  { pattern: /\$\[/, message: '$[] 旧式算术展开' },
  { pattern: /\}\s*always\s*\{/, message: 'zsh always 块 (try/always)' },
  { pattern: /<#/, message: 'PowerShell 注释语法' },
]

interface QuoteExtraction {
  /** 去掉单引号内容、保留双引号内容。 */
  withDoubleQuotes: string
  /** 单/双引号内容都去掉。 */
  fullyUnquoted: string
  /** 去掉引号内**内容**但保留引号字符本身（用于侦测 `'x'#` 这类引号紧邻 # 的去同步）。 */
  unquotedKeepQuoteChars: string
  /** 扫描结束时是否仍处于未闭合的引号中（畸形 token 的信号）。 */
  unbalanced: boolean
}

/**
 * 按 bash 引号/转义语义把命令拆出几种「去引号」视图。移植自 CC 的 extractQuotedContent：
 * 单引号内一切都是字面量（含反斜杠不转义）；双引号内反斜杠可转义；引号外反斜杠转义下一字符。
 */
function extractQuotedContent(command: string): QuoteExtraction {
  let withDoubleQuotes = ''
  let fullyUnquoted = ''
  let unquotedKeepQuoteChars = ''
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (escaped) {
      escaped = false
      if (!inSingle) withDoubleQuotes += ch
      if (!inSingle && !inDouble) {
        fullyUnquoted += ch
        unquotedKeepQuoteChars += ch
      }
      continue
    }
    if (ch === '\\' && !inSingle) {
      escaped = true
      if (!inSingle) withDoubleQuotes += ch
      if (!inSingle && !inDouble) {
        fullyUnquoted += ch
        unquotedKeepQuoteChars += ch
      }
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      unquotedKeepQuoteChars += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      unquotedKeepQuoteChars += ch
      continue
    }
    if (!inSingle) withDoubleQuotes += ch
    if (!inSingle && !inDouble) {
      fullyUnquoted += ch
      unquotedKeepQuoteChars += ch
    }
  }
  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars, unbalanced: inSingle || inDouble }
}

/** content 内是否存在**未被转义**的某单字符（反斜杠转义下一字符）。 */
function hasUnescapedChar(content: string, char: string): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\' && i + 1 < content.length) {
      i++
      continue
    }
    if (content[i] === char) return true
  }
  return false
}

/** 取一段子命令的命令首词：剥掉前导 `VAR=val` 环境赋值、前导反斜杠（`\jq` 绕过别名）。 */
function baseCommandOf(segment: string): string {
  let s = segment.trim()
  // 剥掉前导环境赋值 `FOO=bar `（可多个）。
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
    const sp = s.indexOf(' ')
    if (sp === -1) return ''
    s = s.slice(sp + 1).trimStart()
  }
  const first = s.split(/\s+/)[0] ?? ''
  return first.replace(/^\\/, '')
}

/** 整条命令里所有顶层子命令的命令首词（含 sudo/command/env 后的真实命令的近似）。 */
function baseCommands(command: string): string[] {
  return splitBashCommand(command).map(baseCommandOf).filter((s) => s.length > 0)
}

// ── 各检查实现：返回命中或 null ───────────────────────────────────────────────

/** 1 不完整片段：以 tab / `-`（flag）/ 操作符开头，多半是被截断的续行，应人审。 */
function checkIncomplete(cmd: string): BashSecurityHit | null {
  if (/^\s*\t/.test(cmd))
    return { checkId: 1, name: 'incomplete-commands', severity: 'warn', reason: '命令以制表符开头，疑似不完整片段' }
  const trimmed = cmd.trim()
  if (trimmed.startsWith('-'))
    return { checkId: 1, name: 'incomplete-commands', severity: 'warn', reason: '命令以 flag 开头，疑似不完整片段' }
  if (/^\s*(&&|\|\||;|>>?|<)/.test(cmd))
    return { checkId: 1, name: 'incomplete-commands', severity: 'warn', reason: '命令以操作符开头，疑似续行片段' }
  return null
}

/** 2 jq system()：执行任意命令。 */
function checkJqSystem(cmd: string, bases: string[]): BashSecurityHit | null {
  if (bases.includes('jq') && /\bsystem\s*\(/.test(cmd))
    return { checkId: 2, name: 'jq-system-function', severity: 'block', reason: 'jq system() 可执行任意命令' }
  return null
}

/** 3 jq 危险文件参数：-f/--from-file/--rawfile/--slurpfile/-L 可执行代码或读任意文件。 */
function checkJqFileArgs(cmd: string, bases: string[]): BashSecurityHit | null {
  if (!bases.includes('jq')) return null
  if (/(?:^|\s)(?:-f\b|--from-file|--rawfile|--slurpfile|-L\b|--library-path)/.test(cmd))
    return { checkId: 3, name: 'jq-file-arguments', severity: 'block', reason: 'jq 含可执行代码/读任意文件的危险参数' }
  return null
}

/** 4 混淆 flag：ANSI-C 引用 $'…'、locale 引用 $"…"、空引号紧邻短横、词首 3+ 连续引号。 */
function checkObfuscatedFlags(cmd: string): BashSecurityHit | null {
  if (/\$'[^']*'/.test(cmd))
    return { checkId: 4, name: 'obfuscated-flags', severity: 'block', reason: "ANSI-C 引用 $'…' 可隐藏字符" }
  if (/\$"[^"]*"/.test(cmd))
    return { checkId: 4, name: 'obfuscated-flags', severity: 'block', reason: 'locale 引用 $"…" 可隐藏字符' }
  if (/(?:^|\s)(?:''|"")+\s*-/.test(cmd) || /(?:""|'')+['"]-/.test(cmd))
    return { checkId: 4, name: 'obfuscated-flags', severity: 'block', reason: '空引号紧邻短横，疑似 flag 混淆' }
  if (/(?:^|\s)['"]{3,}/.test(cmd))
    return { checkId: 4, name: 'obfuscated-flags', severity: 'block', reason: '词首连续引号，疑似混淆' }
  return null
}

/** 5 引号内参数夹带 `;`/`|`/`&`：find -name "a;rm" 之类的注入。 */
function checkMetacharsInArgs(unquoted: string): BashSecurityHit | null {
  const patterns = [
    /(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/,
    /-name\s+["'][^"']*[;|&][^"']*["']/,
    /-path\s+["'][^"']*[;|&][^"']*["']/,
    /-iname\s+["'][^"']*[;|&][^"']*["']/,
    /-regex\s+["'][^"']*[;&][^"']*["']/,
  ]
  if (patterns.some((p) => p.test(unquoted)))
    return { checkId: 5, name: 'shell-metacharacters', severity: 'warn', reason: '引号内参数夹带 ; | & 等元字符' }
  return null
}

/** 6 危险变量：变量紧邻管道/重定向（`$x |` / `| $x`），可被滥用。日常常见 → warn。 */
function checkDangerousVariables(fullyUnquoted: string): BashSecurityHit | null {
  if (/[<>|]\s*\$[A-Za-z_]/.test(fullyUnquoted) || /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquoted))
    return { checkId: 6, name: 'dangerous-variables', severity: 'warn', reason: '变量出现在管道/重定向旁' }
  return null
}

/** 7 换行：换行后紧跟非空白（非续行）。zuse 的拆分器已按换行拆子命令逐条校验 → warn。 */
function checkNewlines(fullyUnquoted: string): BashSecurityHit | null {
  if (!/[\n\r]/.test(fullyUnquoted)) return null
  if (/(?:[^\s\\])[\n\r]\s*\S/.test('x' + fullyUnquoted))
    return { checkId: 7, name: 'newlines', severity: 'warn', reason: '命令含可分隔多条命令的换行' }
  return null
}

/** 8 进程替换 / 危险展开：<() >() =() / zsh =cmd / $[ / always 块 / $( / 反引号。 */
function checkSubstitution(unquoted: string): BashSecurityHit | null {
  if (hasUnescapedChar(unquoted, '`'))
    return { checkId: 8, name: 'command-substitution', severity: 'block', reason: '反引号命令替换' }
  for (const { pattern, message } of SUBSTITUTION_PATTERNS) {
    if (pattern.test(unquoted))
      return { checkId: 8, name: 'command-substitution', severity: 'block', reason: message }
  }
  return null
}

/** 9 输入重定向 `<`：可读取敏感文件。日常常见 → warn。 */
function checkInputRedirection(fullyUnquoted: string): BashSecurityHit | null {
  // 排除 <<(heredoc)、<&(fd 复制)、<((进程替换，已由 8 拦)。
  if (/(?:^|[^<&0-9])<(?![<&(])/.test(fullyUnquoted))
    return { checkId: 9, name: 'input-redirection', severity: 'warn', reason: '输入重定向 < 可读取文件' }
  return null
}

/** 10 输出重定向 `>`：可写入任意文件。日常常见 → warn。 */
function checkOutputRedirection(fullyUnquoted: string): BashSecurityHit | null {
  // 排除 >&(fd 复制)、>((进程替换，已由 8 拦)；>> 追加仍按写处理一并提示。
  if (/(?:^|[^>&0-9])>(?![&(])/.test(fullyUnquoted))
    return { checkId: 10, name: 'output-redirection', severity: 'warn', reason: '输出重定向 > 可写入任意文件' }
  return null
}

/** 11 IFS 注入：$IFS / ${…IFS…} 可绕过基于空白的正则校验。 */
function checkIFSInjection(cmd: string): BashSecurityHit | null {
  if (/\$IFS|\$\{[^}]*IFS/.test(cmd))
    return { checkId: 11, name: 'ifs-injection', severity: 'block', reason: '$IFS 用法可绕过安全校验' }
  return null
}

/** 12 git commit 消息内命令替换：-m "...$(...)..."。 */
function checkGitCommitSubstitution(cmd: string, bases: string[]): BashSecurityHit | null {
  if (!bases.includes('git')) return null
  if (/\bgit\s+commit\b/.test(cmd) && /\$\(|`|\$\{/.test(cmd))
    return { checkId: 12, name: 'git-commit-substitution', severity: 'block', reason: 'git commit 消息内含命令/参数替换' }
  return null
}

/** 13 访问 /proc/<pid>/environ：可泄露环境变量（API key 等）。 */
function checkProcEnviron(cmd: string): BashSecurityHit | null {
  if (/\/proc\/.*\/environ/.test(cmd))
    return { checkId: 13, name: 'proc-environ-access', severity: 'block', reason: '访问 /proc/*/environ 可泄露环境变量' }
  return null
}

/** 14 畸形 token：引号未闭合（扫描结束仍在引号内），与 eval 重解析结合可致注入 → warn。 */
function checkMalformedTokens(unbalanced: boolean): BashSecurityHit | null {
  if (unbalanced)
    return { checkId: 14, name: 'malformed-token-injection', severity: 'warn', reason: '引号未闭合，token 畸形' }
  return null
}

/** 15 反斜杠转义的空白：`a\ b` 把多词粘成一词，可隐藏命令名 → warn。 */
function checkBackslashEscapedWhitespace(cmd: string): BashSecurityHit | null {
  if (/\\[ \t]/.test(cmd))
    return { checkId: 15, name: 'backslash-escaped-whitespace', severity: 'warn', reason: '反斜杠转义空白可粘连词法' }
  return null
}

/** 16 花括号展开：{a,b} / {1..9} 会被展开成多项 → warn（find 占位符 {} 不计）。 */
function checkBraceExpansion(fullyUnquoted: string): BashSecurityHit | null {
  if (/\{[^{}]*,[^{}]*\}|\{[^{}]*\.\.[^{}]*\}/.test(fullyUnquoted))
    return { checkId: 16, name: 'brace-expansion', severity: 'warn', reason: '花括号展开可生成多个参数' }
  return null
}

/** 17 控制字符：除 \t\n\r 外的不可见控制字符，常用于隐藏/绕过。 */
function checkControlCharacters(cmd: string): BashSecurityHit | null {
  // 故意匹配控制字符以拦截混淆（除 \t\n\r 外的不可见字节）。
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(cmd))
    return { checkId: 17, name: 'control-characters', severity: 'block', reason: '命令含不可见控制字符' }
  return null
}

/**
 * 18 Unicode 空白/零宽字符：可冒充分隔或隐藏内容。用码点判定而非内联字面量，免得源码里
 * 这些不可见字符在编辑/复制中被悄悄改掉。涵盖 NBSP、Ogham 空格、各类 EN/EM 空格、
 * 行/段分隔符、窄不换行空格、表意空格、BOM，以及零宽空格/连接符。
 */
const UNICODE_WS_CODEPOINTS = new Set<number>([
  0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
  0x200b, 0x200c, 0x200d,
])
function checkUnicodeWhitespace(cmd: string): BashSecurityHit | null {
  for (const ch of cmd) {
    const cp = ch.codePointAt(0)!
    if (UNICODE_WS_CODEPOINTS.has(cp) || (cp >= 0x2000 && cp <= 0x200a))
      return { checkId: 18, name: 'unicode-whitespace', severity: 'block', reason: '命令含 Unicode 空白/零宽字符' }
  }
  return null
}

/** 19 词中井号：引号紧邻 `#`（如 `'x'#`）可造成注释去同步，隐藏后续内容 → warn。 */
function checkMidWordHash(keepQuotes: string): BashSecurityHit | null {
  if (/['"]#/.test(keepQuotes))
    return { checkId: 19, name: 'mid-word-hash', severity: 'warn', reason: '引号紧邻 # 可造成注释去同步' }
  return null
}

/** 20 zsh 危险命令/内建：zmodload、emulate、sys*、zf_* 等（对照命令首词）。 */
function checkZshDangerous(bases: string[]): BashSecurityHit | null {
  const hit = bases.find((b) => ZSH_DANGEROUS_COMMANDS.has(b))
  if (hit)
    return { checkId: 20, name: 'zsh-dangerous-commands', severity: 'block', reason: `zsh 危险命令/内建：${hit}` }
  return null
}

/** 21 反斜杠转义的逻辑操作符：`\&&` / `\||` 可让拆分器与 bash 解析产生差异 → warn。
 *  （刻意不含 `\;` —— `find … -exec … \;` 是极常见的合法写法。） */
function checkBackslashEscapedOperators(cmd: string): BashSecurityHit | null {
  if (/\\&&|\\\|\|/.test(cmd))
    return { checkId: 21, name: 'backslash-escaped-operators', severity: 'warn', reason: '反斜杠转义的逻辑操作符' }
  return null
}

/** 22 注释/引号去同步：存在未闭合引号且命令含 `#`，注释边界可能被错判 → warn。 */
function checkCommentQuoteDesync(cmd: string, unbalanced: boolean): BashSecurityHit | null {
  if (unbalanced && cmd.includes('#'))
    return { checkId: 22, name: 'comment-quote-desync', severity: 'warn', reason: '引号未闭合且含 #，注释边界可疑' }
  return null
}

/** 23 回车符：DQ 之外的 \r 会被 bash 与词法解析器分歧处理（CC 列为 misparsing）。 */
function checkCarriageReturn(cmd: string): BashSecurityHit | null {
  if (!cmd.includes('\r')) return null
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (escaped) { escaped = false; continue }
    if (c === '\\' && !inSingle) { escaped = true; continue }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (c === '\r' && !inDouble)
      return { checkId: 23, name: 'carriage-return', severity: 'block', reason: '回车符 \\r 在 bash 与词法器中解析不一致' }
  }
  return null
}

/**
 * 对一条 Bash 命令跑全部 23 项检查。返回**最严重**的一处命中（有 block 命中则优先返回
 * block，否则返回首个 warn），都没有则 null。permission.decide 只把 `block` 用作压过
 * allow 的依据；`warn` 仅供检测/将来在对话框展示。
 */
export function checkBashSecurity(command: string): BashSecurityHit | null {
  if (!command || !command.trim()) return null

  const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars, unbalanced } = extractQuotedContent(command)
  const bases = baseCommands(command)

  // 按 checkId 顺序求值；优先返回首个 block，否则返回首个 warn。
  const checks: Array<BashSecurityHit | null> = [
    checkIncomplete(command),
    checkJqSystem(command, bases),
    checkJqFileArgs(command, bases),
    checkObfuscatedFlags(command),
    checkMetacharsInArgs(withDoubleQuotes),
    checkDangerousVariables(fullyUnquoted),
    checkNewlines(fullyUnquoted),
    checkSubstitution(withDoubleQuotes),
    checkInputRedirection(fullyUnquoted),
    checkOutputRedirection(fullyUnquoted),
    checkIFSInjection(command),
    checkGitCommitSubstitution(command, bases),
    checkProcEnviron(command),
    checkMalformedTokens(unbalanced),
    checkBackslashEscapedWhitespace(command),
    checkBraceExpansion(fullyUnquoted),
    checkControlCharacters(command),
    checkUnicodeWhitespace(command),
    checkMidWordHash(unquotedKeepQuoteChars),
    checkZshDangerous(bases),
    checkBackslashEscapedOperators(command),
    checkCommentQuoteDesync(command, unbalanced),
    checkCarriageReturn(command),
  ]

  let firstWarn: BashSecurityHit | null = null
  for (const hit of checks) {
    if (!hit) continue
    if (hit.severity === 'block') return hit
    if (!firstWarn) firstWarn = hit
  }
  return firstWarn
}

/** 便捷判定：该命令是否命中 block 档（permission.decide 用它压过 allow）。 */
export function hasBlockingBashSecurityIssue(command: string): BashSecurityHit | null {
  const hit = checkBashSecurity(command)
  return hit && hit.severity === 'block' ? hit : null
}
