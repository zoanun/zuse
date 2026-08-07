import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveShell } from './shell.js'

/**
 * 锁住 shell 三级回退的**顺序**（git-bash → pwsh → cmd）。
 *
 * 为什么单独写这条：抽 proc 层时做变异验证，把 pwsh 提到 git-bash 前面 —— 既有测试
 * 确实变红了，但红的是「exit code 127 / exit code 3」这类**顺手**的断言，而 cwd 持久化
 * 与快照那两条 `it.runIf(getShellLabel()==='bash')` 直接**静默变成 skip**（0 skipped → 2 skipped）。
 * 也就是说：换个不那么破坏退出码语义的 shell，这个顺序就没人守了。而这段逻辑现在是
 * 将来 run 服务的共享依赖（设计 §1），选错 shell 的症状是「模型出的 Unix 命令全挂」。
 *
 * 用假的 PATH + 假的可执行文件（findOnPath 只做 existsSync，不执行），所以不依赖本机
 * 究竟装没装 pwsh / git，也不会真起进程。
 */

/** 造一个空文件当「可执行文件」——findOnPath 只 existsSync，够用。 */
function touchExe(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  writeFileSync(p, '')
  return p
}

/** 临时替换 PATH / ZUSE_SHELL / SHELL 跑一段，结束后原样还回去。 */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('resolveShell', () => {
  it('ZUSE_SHELL 存在时压过一切自动探测', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-shellsel-'))
    try {
      const custom = touchExe(dir, 'my-shell.exe')
      expect(withEnv({ ZUSE_SHELL: custom }, resolveShell)).toBe(custom)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ZUSE_SHELL 指向不存在的路径时忽略它（不能让子进程直接起不来）', () => {
    const bogus = path.join(tmpdir(), 'zuse-no-such-shell-zzz.exe')
    expect(existsSync(bogus)).toBe(false)
    const picked = withEnv({ ZUSE_SHELL: bogus }, resolveShell)
    expect(picked).not.toBe(bogus)
  })
})

/**
 * 本机若真装了「标准安装位置」的 Git，resolveShell 会在探到 pwsh 之前先命中那条兜底 ——
 * 分支本身正确，但 pwsh / cmd 两级就测不到了。跳过而不是假绿；跳过的理由写进用例名，
 * 好在测试报告里一眼可见（CLAUDE.md §三：跳过必须可见）。
 */
const PROGRAM_FILES_GIT = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
  .find((p) => existsSync(p))

describe.skipIf(process.platform !== 'win32')('resolveShell（Windows 三级回退顺序）', () => {
  it('git-bash 与 pwsh 都在 PATH 上时，选 git-bash', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zuse-shellsel-'))
    try {
      // 造一棵 Git 安装树：<root>\git\cmd\git.exe + <root>\git\bin\bash.exe
      const gitRoot = path.join(root, 'git')
      touchExe(path.join(gitRoot, 'cmd'), 'git.exe')
      const bash = touchExe(path.join(gitRoot, 'bin'), 'bash.exe')
      const pwshDir = path.join(root, 'ps')
      touchExe(pwshDir, 'pwsh.exe')
      const picked = withEnv(
        { ZUSE_SHELL: undefined, PATH: `${path.join(gitRoot, 'cmd')};${pwshDir}` },
        resolveShell,
      )
      expect(picked).toBe(bash)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(PROGRAM_FILES_GIT)('PATH 上只有 pwsh 时选 pwsh（而不是直接回退 cmd.exe）[本机装了 Program Files 版 Git 则跳过]', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zuse-shellsel-'))
    try {
      const pwshDir = path.join(root, 'ps')
      const pwsh = touchExe(pwshDir, 'pwsh.exe')
      const picked = withEnv({ ZUSE_SHELL: undefined, PATH: pwshDir }, resolveShell)
      expect(picked).toBe(pwsh)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(PROGRAM_FILES_GIT)('PATH 上 git-bash 与 pwsh 都没有时回退 cmd.exe（shell:true）[同上]', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'zuse-shellsel-'))
    try {
      const picked = withEnv({ ZUSE_SHELL: undefined, PATH: root }, resolveShell)
      expect(picked).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform === 'win32')('resolveShell（POSIX 登录 shell 优先）', () => {
  it('$SHELL 是 bash/zsh 且存在时直接取它', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-shellsel-'))
    try {
      const login = touchExe(dir, 'zsh')
      expect(withEnv({ ZUSE_SHELL: undefined, SHELL: login }, resolveShell)).toBe(login)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('$SHELL 不是 bash/zsh 时不取它（快照只支持这两类）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zuse-shellsel-'))
    try {
      const fish = touchExe(dir, 'fish')
      expect(withEnv({ ZUSE_SHELL: undefined, SHELL: fish }, resolveShell)).not.toBe(fish)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
