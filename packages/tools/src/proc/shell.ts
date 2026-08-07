/**
 * 进程层 —— shell 选型。
 *
 * 从 `bash.ts` **原样**抽出（纯提取重构，判断逻辑与回退顺序一字未改）。抽出来的理由见
 * `docs/superpowers/specs/2026-08-07-code-exec-runner-v3-design.md` §1：将来的
 * 「在项目目录里跑命令 + 流式输出」run 服务要复用同一套选型 —— 这里每一条分支都是
 * 在 Windows 上真踩出来的（`.cmd`/`.bat` 的 ENOENT、`spawn('mvn.cmd')` 同步抛 EINVAL、
 * PowerShell 5.1 不支持 `&&`），另起一套必然漏。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { findOnPath } from '../util.js'

/** git-bash 相对 Git 安装根目录的两种固定布局。 */
function gitBashUnder(root: string): string | undefined {
  for (const rel of ['bin\\bash.exe', 'usr\\bin\\bash.exe']) {
    const p = path.join(root, rel)
    if (existsSync(p)) return p
  }
  return undefined
}

/**
 * 解析 Bash 工具实际使用的 shell。
 *
 * POSIX：优先用户登录 shell（$SHELL，通常 /bin/bash 或 /bin/zsh）。不直接用
 * spawn 的 shell:true（那会落到 /bin/sh，多为 dash）—— 用户的 alias、shell 函数、
 * rc 注入的 PATH 都只存在于其登录 shell 里；/bin/sh 既看不到这些、也没有
 * declare -f / 别名展开能力，登录 shell 快照（见 shell-snapshot.ts）就无从建立。
 * $SHELL 须是 bash/zsh 才取（这两类快照已支持）；否则按序探测常见安装路径，
 * 都不可用才回退 shell:true（/bin/sh），此时快照优雅降级、命令仍照常执行。
 *
 * Windows 上 shell:true 会落到 cmd.exe —— 没有 pwd/ls，而模型几乎总按 Unix 习惯
 * 出命令，于是频繁 "'pwd' is not recognized"。所以优先找 git-bash，让 Unix 命令
 * （含 && / ; / | 等分隔符）跨平台一致可用；没有 git-bash 退到 pwsh7，再不行才回退 cmd.exe。
 *
 * 不直接在 PATH 上搜 bash.exe：那样会误抓 System32 的 WSL bash 或 WindowsApps
 * 的商店占位，二者路径语义与 git-bash 完全不同。改为定位 PATH 上的 git.exe 再
 * 反推 git-bash —— git 几乎总在开发者 PATH 上，且兼容任意安装位置（不限 Program Files）。
 *
 * 没有 git-bash 时退一步找 pwsh.exe（PowerShell 7+）：它的 && / || / ; / | 都支持，
 * 且 pwd/ls/cd/cat 有别名，比 cmd 更接近 Unix 习惯。注意只认 pwsh.exe，不认
 * powershell.exe —— 后者是系统自带的 Windows PowerShell 5.1，恰恰不支持 && / ||
 * （5.1 会解析报错），回退到它反而会弄坏模型最常出的 `a && b` 命令链，还不如 cmd。
 * 两者都没有才回退 cmd.exe（始终存在、支持 &&、且 Node spawn 对它有特殊处理最稳）。
 *
 * 可用 ZUSE_SHELL 环境变量显式覆盖（两平台通用）。路径在进程生命周期内不变，
 * 模块加载时解析一次即可 —— 运行期一律用 `resolvedShell()` 拿那一次的结果。
 *
 * 本函数导出**仅**为让测试能直接锁住三级回退的顺序（每次调用都重新探测 PATH）：
 * 此前这段逻辑没有任何直接测试，变异（把 pwsh 提到 git-bash 前面）只是被
 * 「退出码透传」之类的断言顺手打死，且会让两条 `it.runIf` 静默变成 skip。
 */
export function resolveShell(): string | true {
  if (process.env.ZUSE_SHELL && existsSync(process.env.ZUSE_SHELL)) return process.env.ZUSE_SHELL
  if (process.platform !== 'win32') {
    // 用户登录 shell 优先（仅取 bash/zsh，快照已支持这两类）。
    const login = process.env.SHELL
    if (login && /(?:bash|zsh)$/.test(login) && existsSync(login)) return login
    // $SHELL 缺失/不是 bash/zsh 时，按序探测常见安装路径。
    for (const p of ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh']) {
      if (existsSync(p)) return p
    }
    return true // 回退 /bin/sh，快照随之降级
  }
  const git = findOnPath('git.exe')
  if (git) {
    // git 可能在 <root>\cmd\git.exe、<root>\bin\git.exe 或 <root>\mingw64\bin\git.exe，
    // 各自到 Git 根目录的层级不同 —— 从 git.exe 所在目录逐级上溯，命中即止。
    let dir = path.dirname(git)
    for (let i = 0; i < 4; i++) {
      const bash = gitBashUnder(dir)
      if (bash) return bash
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // 标准安装位置兜底（git 不在 PATH 时）。
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) {
    if (existsSync(p)) return p
  }
  // 没有 git-bash：优先 PowerShell 7+（pwsh.exe），不行才回退 cmd.exe。
  const pwsh = findOnPath('pwsh.exe')
  if (pwsh) return pwsh
  return true // 回退 cmd.exe
}

/** 模块加载时解析一次；spawn 与 getShellLabel 共用同一结果。 */
const SHELL: string | true = resolveShell()

/**
 * 本进程选定的 shell（`spawn` 的 `shell` 选项原值：绝对路径，或 `true` = 交给 Node
 * 回退到 /bin/sh / cmd.exe）。原先是 bash.ts 的模块级常量 `SHELL`，抽出来后改成取值
 * 函数，语义不变（仍是模块加载时解析一次、进程生命周期内不变）。
 */
export function resolvedShell(): string | true {
  return SHELL
}

/**
 * 当前 Bash 工具实际使用的 shell 的人类可读标签，供系统提示词的环境块使用，
 * 让模型按真实 shell（bash / pwsh / cmd.exe / sh）出命令，而不是凭训练惯性瞎猜。
 */
export function getShellLabel(): string {
  if (SHELL === true) return process.platform === 'win32' ? 'cmd.exe' : 'sh'
  // zsh 在 bash 之前判：避免 "/usr/bin/zsh" 这类路径里万一含子串时误判（且语义独立）。
  if (/zsh/i.test(SHELL)) return 'zsh'
  if (/bash/i.test(SHELL)) return 'bash'
  if (/pwsh/i.test(SHELL)) return 'pwsh'
  return SHELL
}
