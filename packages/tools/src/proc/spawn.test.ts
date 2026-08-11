import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnShellCommand } from './spawn.js'
import { getShellLabel } from './shell.js'
import { killTree } from '../util.js'

/** 本文件建的临时目录，收尾统一删 —— 否则每跑一次测试就往 %TEMP% 里漏两个目录。 */
const TEMP_DIRS: string[] = []
afterAll(() => {
  for (const d of TEMP_DIRS) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 清理失败不该让测试变红 */ }
  }
})

/**
 * 造一个「读 stdin 直到 EOF 才退出」的子进程命令。
 *
 * 为什么不用 `more` / `sort` / `cat` 这类现成命令：本项目的 shell 是运行期选出来的
 * （git-bash / pwsh / cmd.exe / sh 四选一，见 proc/shell.ts），这些名字在四种 shell 下
 * 分别是外部程序、别名、内建，行为并不一致 —— pwsh 的 `sort` 是 Sort-Object，
 * 压根不读控制台 stdin，测试会在那台机器上静默变成「本来就不挂」的假绿。
 * 改用 node 跑一个脚本：跑测试的进程自己就是 node，必然存在，四种 shell 下语义一致。
 */
function makeStdinReaderCommand(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'zuse-stdin-'))
  TEMP_DIRS.push(dir)
  const script = path.join(dir, 'read-stdin.cjs')
  writeFileSync(script, 'process.stdin.resume();process.stdin.on("end",function(){process.exit(0)});\n')
  return quoteForShell(`"${process.execPath}" "${script.split('\\').join('/')}"`)
}

/**
 * PowerShell 里以引号开头的一行会被当**表达式**解析，`"C:\node.exe" "script.js"` 直接
 * ParserError（exit 1，两档都秒退）—— 那会让下面的护栏在 pwsh 机器上**静默变成假绿**：
 * 测试通过，但什么都没验到。加 `&`（调用运算符）才是「执行它」。
 * 反过来 bash 里裸加 `&` 是后台运算符，会 syntax error —— 所以必须按 shell 分。
 * shell 选型见 proc/shell.ts（git-bash / pwsh / cmd.exe / sh 四选一，运行期决定）。
 */
function quoteForShell(cmd: string): string {
  return getShellLabel() === 'pwsh' ? `& ${cmd}` : cmd
}

/** 起进程并等它退出；超过 ms 判定为挂死（并杀掉，别把进程漏给测试机）。 */
function exitsWithin(command: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnShellCommand(command, { cwd: process.cwd() })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // 复用产品代码的 killTree（含 undefined pid 的守卫、Windows/POSIX 两条路径），
      // 别在测试里手搓第二份 —— 手搓那份漏了 pid 守卫，会去 taskkill 一个 "undefined"。
      killTree(child.pid)
      resolve(false)
    }, ms)
    child.on('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true) // 起不来也不算挂死
    })
  })
}

describe('spawnShellCommand 的 stdin', () => {
  it('默认不给子进程 stdin —— 读 stdin 的命令立刻拿到 EOF，而不是永久挂起', async () => {
    // 这条是本次改动的全部理由：默认 stdio 是 pipe，而没人往那根管子里写、也没人关它，
    // 于是任何读 stdin 的命令都会等到天荒地老。Bash 工具有超时兜底（只是白等一整个超时），
    // 将来的 run 服务「项目档」**没有墙钟** —— 不修就是真·永久挂起。
    expect(await exitsWithin(makeStdinReaderCommand(), 5000)).toBe(true)
  }, 15000)

  it('显式 stdin:"pipe" 时才给出可写的 stdin（写入并 end 后子进程退出）', async () => {
    const child = spawnShellCommand(makeStdinReaderCommand(), {
      cwd: process.cwd(),
      stdin: 'pipe',
    })
    expect(child.stdin).not.toBeNull()
    const exited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    child.stdin?.end('hello\n')
    expect(await exited).toBe(true)
  }, 15000)

  it('默认档下 child.stdin 为 null —— 类型上就不许当成可写流用', () => {
    // 用同一条读 stdin 的命令，不另挑 `cmd /c ver`：git-bash 会把 `/c` 改写成 `C:/`
    // （MSYS 路径转换），cmd 收不到 `/c` 反而进交互模式 —— 一条本以为「秒退」的命令
    // 在本项目默认 shell 下恰恰是会挂的那种。
    const child = spawnShellCommand(makeStdinReaderCommand(), { cwd: process.cwd() })
    expect(child.stdin).toBeNull()
    killTree(child.pid)
  })
})
