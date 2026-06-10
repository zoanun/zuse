/**
 * tmux 套接字隔离（对齐 Claude Code 的 src/utils/tmuxSocket.ts）。
 *
 * 为什么要有：只要 zuse 允许模型在 Bash 里跑 `tmux ...`，就有「误伤用户自己 tmux 会话」
 * 的风险 —— 比如用户从某个 tmux 会话里启动 zuse，模型一句 `tmux kill-server` 就把用户的
 * 会话连根拔了。
 *
 * 怎么隔离：给 zuse 开一个**专属套接字** `zuse-<PID>`，在它上面建一个 detached 会话，拿到
 * 该 server 的 `socket_path` 与 `pid`，拼成 tmux 自己那套 `TMUX` 环境变量格式
 * （`socket_path,server_pid,pane`）。随后把这个值作为 `TMUX` **注入并覆盖**所有 Bash 子进程的
 * 同名变量 —— tmux 用 `TMUX` 判定「当前在哪个 server」，于是模型跑的任何 `tmux` 命令
 * （kill-server / new-window / …）都只动 zuse 自己的 server，碰不到用户的会话。
 *
 * 平台说明（务实，见 phase-roadmap §5.5.2）：tmux 仅存在于 POSIX 与 Windows 的 WSL。
 * - POSIX：直接 `tmux`，env 注入与 Bash 同处一个进程环境，隔离完整生效。
 * - Windows：tmux 只在 WSL 内（经 `wsl -e tmux`）。而 zuse 的 Bash 工具走 git-bash，
 *   `tmux` 在 git-bash 里本就不存在，注入的 `TMUX` 也跨不进 WSL 的环境命名空间 —— 故
 *   Windows 上本模块基本是 no-op（探测会返回 WSL 内有无 tmux，但 git-bash 命令用不到）。
 * - 探测不到 tmux：全程优雅降级，Bash 命令照常跑，只是没有隔离。
 *
 * 不做（归 Phase 11）：用 tmux pane 作为后台/异步命令与多 Agent 的执行后端 —— 那是真正的
 * 隔离执行模型，与编排强耦合。本模块只做「套接字隔离」这一轻量层。
 */

import { spawn, spawnSync } from 'node:child_process'
import { posix } from 'node:path'

/** tmux 可执行名。 */
const TMUX = 'tmux'
/** zuse 专属套接字前缀。 */
const SOCKET_PREFIX = 'zuse'
const isWindows = process.platform === 'win32'

interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * 跑一条 tmux 控制命令；Windows 上经 `wsl -e tmux` 路由。永不抛错 —— 失败以 code≠0 返回，
 * 调用方据此降级。`-e` 让 wsl 直接 exec tmux、不经登录 shell（否则 bash 会把 `#{...}`
 * 里的 `#` 当注释吃掉，display-message 取不到 socket_path/pid）。
 */
function execTmux(args: string[]): Promise<ExecResult> {
  const cmd = isWindows ? 'wsl' : TMUX
  const argv = isWindows ? ['-e', TMUX, ...args] : args
  const env = isWindows ? { ...process.env, WSL_UTF8: '1' } : process.env
  return new Promise<ExecResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(cmd, argv, { env })
    } catch {
      resolve({ stdout: '', stderr: 'spawn failed', code: 1 })
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => (stdout += c))
    child.stderr?.on('data', (c: string) => (stderr += c))
    child.on('error', () => resolve({ stdout, stderr: stderr || 'spawn error', code: 1 }))
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }))
  })
}

// ── 模块级状态（懒初始化，进程内仅建一次） ──────────────────────────────────
let socketName: string | null = null
let socketPath: string | null = null
let serverPid: number | null = null
let initPromise: Promise<void> | null = null
let availability: boolean | null = null
let cleanupRegistered = false

/** zuse 隔离套接字名：`zuse-<PID>`。 */
export function getZuseTmuxSocketName(): string {
  if (!socketName) socketName = `${SOCKET_PREFIX}-${process.pid}`
  return socketName
}

/** 套接字是否已成功初始化（建好会话并拿到 socket_path + pid）。 */
export function isTmuxSocketInitialized(): boolean {
  return socketPath !== null && serverPid !== null
}

/**
 * 注入给 Bash 子进程的 `TMUX` 值：`socket_path,server_pid,0`（与 tmux 原生格式一致）。
 * 未初始化返回 null —— 此时 Bash 不覆盖 `TMUX`，保留用户原环境。
 */
export function getZuseTmuxEnv(): string | null {
  if (!socketPath || serverPid === null) return null
  return `${socketPath},${serverPid},0`
}

/**
 * 一条命令里是否出现 `tmux`（作为完整单词）—— 用于「按需」触发套接字初始化，避免不碰 tmux
 * 的会话白白开一个 server。刻意从宽（整词匹配即可，哪怕 tmux 出现在引号/管道/xargs 里）：
 * 隔离场景下「多开一个隔离 server」远比「漏开导致没隔离」安全，故宁可错触发不可漏。
 * 仅 `mytmux`/`tmuxinator` 这类把 tmux 当子串的更大单词不算。
 */
export function isTmuxCommand(command: string): boolean {
  return /\btmux\b/.test(command)
}

/** 探测 tmux 是否可用（缓存一次）。POSIX 跑 `tmux -V`；Windows 跑 `wsl -e tmux -V`。 */
export async function checkTmuxAvailable(): Promise<boolean> {
  if (availability === null) {
    const res = await execTmux(['-V'])
    availability = res.code === 0
  }
  return availability
}

/**
 * 确保隔离套接字就绪（可重复调用，仅初始化一次；不可用/失败均优雅降级、不抛错）。
 * Bash 工具在命令含 tmux 时调用它，随后用 getZuseTmuxEnv() 注入子进程环境。
 */
export async function ensureTmuxSocket(): Promise<void> {
  if (isTmuxSocketInitialized()) return
  if (!(await checkTmuxAvailable())) return
  if (initPromise) {
    try {
      await initPromise
    } catch {
      // 由首个调用方记录，这里忽略
    }
    return
  }
  initPromise = doInitialize()
  try {
    await initPromise
  } catch {
    // 优雅降级：拿不到隔离套接字就照常跑，不影响主流程
  }
}

async function doInitialize(): Promise<void> {
  const socket = getZuseTmuxSocketName()

  // 在专属套接字上建一个 detached 会话。同名 server 已存在（同 PID 复用，极少见）则视作就绪。
  const created = await execTmux(['-L', socket, 'new-session', '-d', '-s', 'base'])
  if (created.code !== 0) {
    const has = await execTmux(['-L', socket, 'has-session', '-t', 'base'])
    if (has.code !== 0) throw new Error(`无法在套接字 ${socket} 上建会话：${created.stderr}`)
  }

  registerCleanup()

  // 取 socket_path 与 server pid，拼成 TMUX 环境值。
  const info = await execTmux(['-L', socket, 'display-message', '-p', '#{socket_path},#{pid}'])
  if (info.code === 0) {
    const [path, pidStr] = info.stdout.trim().split(',')
    const pid = Number(pidStr)
    if (path && Number.isInteger(pid)) {
      socketPath = path
      serverPid = pid
      return
    }
  }

  // 兜底：按 tmux 默认位置拼套接字路径（$TMPDIR/tmux-<uid>/<socket>），server pid 单独取。
  const uid = process.getuid?.() ?? 0
  const baseTmp = process.env.TMPDIR || '/tmp'
  const fallbackPath = posix.join(baseTmp, `tmux-${uid}`, socket)
  const pidRes = await execTmux(['-L', socket, 'display-message', '-p', '#{pid}'])
  const pid = Number(pidRes.stdout.trim())
  if (pidRes.code === 0 && Number.isInteger(pid)) {
    socketPath = fallbackPath
    serverPid = pid
    return
  }

  throw new Error(`取套接字 ${socket} 信息失败：${info.stderr || pidRes.stderr}`)
}

/**
 * 进程正常退出时杀掉 zuse 的 tmux server，避免遗留 detached server。注册一次即可。
 * 'exit' 回调必须同步，故用 spawnSync。不挂 SIGINT 处理器：zuse 的 TUI 处于 raw 模式、
 * Ctrl+C 走 Ink 的输入事件（不发 SIGINT），双击退出会让进程正常退出、'exit' 自会触发；
 * 抢 SIGINT 反而可能与 Ink 的退出逻辑打架。被 SIGKILL/SIGTERM 强杀时遗留一个隔离 server
 * 属可接受的小代价（套接字名唯一、不碰用户会话）。
 */
function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.once('exit', () => {
    if (!isTmuxSocketInitialized()) return
    const socket = getZuseTmuxSocketName()
    const cmd = isWindows ? 'wsl' : TMUX
    const argv = isWindows ? ['-e', TMUX, '-L', socket, 'kill-server'] : ['-L', socket, 'kill-server']
    try {
      spawnSync(cmd, argv, { env: isWindows ? { ...process.env, WSL_UTF8: '1' } : process.env, timeout: 2000 })
    } catch {
      // server 可能已死，忽略
    }
  })
}

/** 仅供测试：重置模块状态。 */
export function resetTmuxStateForTest(): void {
  socketName = null
  socketPath = null
  serverPid = null
  initPromise = null
  availability = null
  cleanupRegistered = false
}
