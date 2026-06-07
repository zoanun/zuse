/**
 * 登录 shell 环境快照（对齐 Claude Code 的 ShellSnapshot，见 cc-haha/src/utils/bash/ShellSnapshot.ts）。
 *
 * 痛点：Bash 工具 spawn 的子 shell 不读 .bashrc/.zshrc，用户的 alias、shell 函数、
 * 以及 rc 往 PATH 注入的工具全看不见 —— 典型 "command not found"。
 *
 * 做法：启动时用一次登录+交互 shell 跑一段构建脚本，让 shell 自己把"sourcing rc 之后"的
 * 环境（shell 选项 / 函数 / alias / PATH）**追加写进**一个 .sh 快照文件；此后每条 Bash
 * 命令开头 `source` 它 —— 一次性付 login shell 的钱，之后每条命令复用。
 *
 * 与早期版本的区别（本次对齐 CC 后重写）：
 *  1. 不再抓 stdout + 用 MARKER 切 banner，而是脚本内 `>>` 直接写文件——rc 的欢迎语只去
 *     stdout（被丢弃），从根上没有 banner 污染问题。
 *  2. 快照文件开头 `unalias -a`：定义函数前先清空所有别名，规避 zsh 的
 *     "defining function based on alias"（run-help 等）与 bash 的别名冻结；别名放到最后再加回。
 *  3. 函数转储滤掉单下划线补全函数（`grep -vE '^_[^_]'`），保留 `__` 开头的 mise/pyenv helper：
 *     补全函数对非交互执行无用，量大（本机曾 144 个 / 95KB），且其函数体常含 extglob 语法。
 *  4. bash 函数逐个 base64 + 单独 `eval`：单个坏函数只失败它自己，不拖垮整份 source。
 *
 * 仍用 `-i -l`（交互+登录）而非 CC 的纯 `-l`：`.bashrc` 常带 `case $- in *i*) ;; *) return`
 * 的非交互守卫，纯 `-l` 即便显式 source 也会被守卫提前 return 漏掉别名；`-i` 让 `$-` 含 `i`、
 * 守卫放行。再叠加脚本里显式 `source rc`，兜住"`.bash_profile` 没串联 `.bashrc`"的情况。
 *
 * 支持 bash 与 zsh：Windows 走 git-bash(label 'bash')，POSIX 走用户 $SHELL(label 'bash'/'zsh'，
 * 由 resolveShell 解析，见 bash.ts)。仅当 label 为 bash/zsh 且 shell 为真实路径时构建；
 * /bin/sh(label 'sh')、pwsh、cmd 一律优雅降级返回 null，命令与现状一致。
 * 详见 docs/superpowers/specs/2026-06-06-zuse-shell-snapshot-design.md。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 构建超时（毫秒）：rc 卡住时兜底，超时→视为失败→降级。 */
const SNAPSHOT_TIMEOUT = 10_000

/** 转成 shell 可用的正斜杠路径 —— git-bash 的 source 不认反斜杠。 */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** label → 用户 rc 文件绝对路径（脚本会显式 source 它）。 */
function configFileFor(label: string): string {
  return path.join(homedir(), label === 'zsh' ? '.zshrc' : '.bashrc')
}

/** 别名转储片段（bash/zsh 通用）：剥掉 bash 的 `alias ` 前缀（zsh 裸 alias 无前缀），
 * 统一加 `alias -- ` 前缀变成可重新 source 的形式；Windows git-bash 额外过滤 winpty 别名
 * （形如 `alias node='winpty node.exe'`，无 tty 管道里会报 "stdin is not a tty" 并坏掉输出）。 */
const ALIAS_DUMP_LINES: string[] = [
  `echo '# 别名(放最后:此时函数已定义完,加别名不再与函数定义碰撞;Windows git-bash 过滤 winpty)' >> "$SNAPSHOT_FILE"`,
  `if [[ "$OSTYPE" == msys* || "$OSTYPE" == cygwin* ]]; then`,
  `  alias 2>/dev/null | grep -v "='winpty " | sed 's/^alias //' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`,
  `else`,
  `  alias 2>/dev/null | sed 's/^alias //' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"`,
  `fi`,
]

/** bash 专属转储片段：先恢复 shopt（含 extglob，须在函数定义前，否则 bash-completion 风格
 * 的 extglob 函数体解析报错）、开 expand_aliases，再逐个 `declare -f` 转储过滤后的函数。
 *
 * 注意：CC 对每个函数 base64 编码后单独 eval（坏函数不拖垮整份）。zuse 实测在 Windows
 * git-bash 上对 ~144 个函数各 spawn 一次 `base64` 外部进程,构建耗时冲到 6–8s 不可接受;
 * 改用内建 `declare -f "$func"` 循环转储(循环内零进程 spawn)。extglob 解析风险已由前置
 * `shopt -p` 兜住,补全函数也已被过滤,故直接转储安全。
 * 不照搬 `set -o`：errexit/pipefail/nounset 等会破坏 bash.ts 的 `source; 命令; 捕获pwd; exit $?` 包装。 */
const BASH_BODY_LINES: string[] = [
  `echo '# Shell 选项(含 extglob,须在函数定义前恢复;不导出 errexit/pipefail 等行为开关以免破坏命令包装)' >> "$SNAPSHOT_FILE"`,
  `shopt -p 2>/dev/null | head -n 1000 >> "$SNAPSHOT_FILE"`,
  `echo 'shopt -s expand_aliases 2>/dev/null' >> "$SNAPSHOT_FILE"`,
  `echo '# 函数(滤掉单下划线补全函数,保留 __ 开头的 mise/pyenv helper)' >> "$SNAPSHOT_FILE"`,
  `declare -f > /dev/null 2>&1`,
  `declare -F 2>/dev/null | cut -d' ' -f3 | grep -vE '^_[^_]' | while read -r func; do declare -f "$func" >> "$SNAPSHOT_FILE"; done`,
]

/** zsh 专属转储片段：只恢复与"函数体解析"相关的 glob 选项（不照搬全部 setopt，以免
 * err_exit/no_clobber 等破坏命令包装），再直接 typeset -f 转储过滤后的函数（zsh 无需 base64）。 */
const ZSH_BODY_LINES: string[] = [
  `echo '# Shell 选项(只恢复 glob 相关,不照搬全部 setopt 以免 err_exit/no_clobber 破坏命令包装)' >> "$SNAPSHOT_FILE"`,
  `setopt 2>/dev/null | grep -iE '^(extendedglob|kshglob|globsubst|nomatch|bareglobqual|globstarshort|shglob)$' | sed 's/^/setopt /' >> "$SNAPSHOT_FILE"`,
  `echo '# 函数(滤掉单下划线补全函数,保留 __ helper;zsh 直接 typeset -f 转储,无需逐函数编码)' >> "$SNAPSHOT_FILE"`,
  `typeset -f > /dev/null 2>&1`,
  `typeset +f 2>/dev/null | grep -vE '^_[^_]' | while read -r func; do`,
  `  typeset -f "$func" >> "$SNAPSHOT_FILE"`,
  `done`,
]

export interface SnapshotScriptOptions {
  /** 'bash' | 'zsh'，决定转储语法。 */
  label: string
  /** 快照输出文件（正斜杠路径）。 */
  snapshotFile: string
  /** 用户 rc 文件（正斜杠路径），configFileExists 为 true 时脚本会显式 source 它。 */
  configFile: string
  /** rc 文件是否存在；不存在则只捕获登录环境（仍能拿到 PATH）。 */
  configFileExists: boolean
}

/**
 * 生成"构建快照"的脚本：交给 `shell -i -l -c <脚本>` 执行。脚本先（按需）显式 source rc，
 * 再把 unalias→选项→函数→别名→PATH 依次 `>>` 追加进快照文件。返回的脚本本身就是要跑的命令串
 * （由 spawn 以 argv 传给 shell，不经二次 shell 转义），故内部引号按目标 shell 语法即可。
 *
 * 快照文件内的执行顺序刻意为:unalias -a → shell 选项 → 函数 → 别名 → PATH。选项必须在函数之前
 * （extglob 等先就位,含该语法的函数体才能解析）;别名必须在函数之后（定义函数时无别名,规避碰撞）。
 */
export function snapshotBuilderScript(opts: SnapshotScriptOptions): string {
  const { label, snapshotFile, configFile, configFileExists } = opts
  const head: string[] = [
    `SNAPSHOT_FILE='${snapshotFile}'`,
    configFileExists
      ? `source '${configFile}' < /dev/null 2>/dev/null || true`
      : `# 无 ${label === 'zsh' ? '.zshrc' : '.bashrc'} 可 source,仅捕获登录环境`,
    // `>|` 强制截断（即便 noclobber 也覆盖），建立/清空快照文件。
    `echo '# zuse 登录 shell 环境快照(自动生成,勿手改)' >| "$SNAPSHOT_FILE"`,
    `echo '# 先清空别名:定义函数前若有同名别名,zsh 报 "defining function based on alias"、bash 会把别名冻结进函数体。' >> "$SNAPSHOT_FILE"`,
    `echo 'unalias -a 2>/dev/null || true' >> "$SNAPSHOT_FILE"`,
  ]
  const body = label === 'zsh' ? ZSH_BODY_LINES : BASH_BODY_LINES
  const tail: string[] = [
    ...ALIAS_DUMP_LINES,
    `echo '# PATH(source rc 之后的完整 PATH,%q 安全转义)' >> "$SNAPSHOT_FILE"`,
    `printf 'export PATH=%q\\n' "$PATH" >> "$SNAPSHOT_FILE"`,
    // 文件没写成（空）即视为失败,让 Node 端降级返回 null。
    `if [ ! -s "$SNAPSHOT_FILE" ]; then echo 'zuse: empty snapshot' >&2; exit 1; fi`,
  ]
  return [...head, ...body, ...tail].join('\n')
}

/** 记忆化的进程级快照构建结果（首次构建后复用同一 Promise）。 */
let cached: Promise<string | null> | undefined

/**
 * 构建一次登录 shell 环境快照，返回可直接 source 的正斜杠路径，或 null。
 * 仅 label 为 bash/zsh 且 shell 为真实路径时构建；其余一律优雅降级。任何失败
 * （spawn 错/超时/文件空/异常）都返回 null,命令退回未快照行为。记忆化:进程内仅首次真正构建。
 */
export function ensureShellSnapshot(shell: string | true, label: string): Promise<string | null> {
  if (!cached) cached = buildSnapshot(shell, label)
  return cached
}

function buildSnapshot(shell: string | true, label: string): Promise<string | null> {
  // 仅 bash/zsh 且 shell 为真实路径才构建；/bin/sh、pwsh、cmd 等一律降级。
  if ((label !== 'bash' && label !== 'zsh') || typeof shell !== 'string') return Promise.resolve(null)
  return new Promise<string | null>((resolve) => {
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      const dir = path.join(homedir(), '.zuse', 'shell-snapshots')
      mkdirSync(dir, { recursive: true })
      const fileRaw = path.join(dir, `snapshot-${label}-${process.pid}.sh`)
      const snapshotFile = toPosixPath(fileRaw)
      const configRaw = configFileFor(label)
      const script = snapshotBuilderScript({
        label,
        snapshotFile,
        configFile: toPosixPath(configRaw),
        configFileExists: existsSync(configRaw),
      })
      // -i -l：交互+登录。交互（-i）让 .bashrc 的 `case $- in *i*)` 非交互守卫放行；登录（-l）
      // 走 profile 链。脚本内还会显式 source rc 兜底。stdout/stderr 全 ignore：rc banner 与
      // 无 tty 的 "cannot set terminal process group" 噪音都丢弃（快照走文件,不靠 stdout）。
      // GIT_EDITOR=true 防 rc 里的 git 钩子开编辑器卡住；SHELL 让依赖 $SHELL 的 rc 行为正常。
      const child = spawn(shell, ['-i', '-l', '-c', script], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: SNAPSHOT_TIMEOUT,
        env: { ...process.env, SHELL: shell, GIT_EDITOR: 'true' },
      })
      child.on('error', () => finish(null))
      child.on('close', () => {
        try {
          if (statSync(fileRaw).size > 0) {
            // 进程退出时清理（best-effort 同步删）。
            process.once('exit', () => {
              try {
                unlinkSync(fileRaw)
              } catch {
                /* 退出清理 best-effort,忽略 */
              }
            })
            finish(snapshotFile)
            return
          }
        } catch {
          /* stat 失败：文件没建出来 */
        }
        finish(null)
      })
    } catch {
      finish(null)
    }
  })
}
