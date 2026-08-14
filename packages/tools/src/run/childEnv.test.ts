import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnShellCommand } from '../proc/spawn.js'
import { getShellLabel } from '../proc/shell.js'
import { runEnv } from './childEnv.js'

const TEMP_DIRS: string[] = []
afterAll(() => {
  for (const d of TEMP_DIRS) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 清理失败不该让测试变红 */ }
  }
})

/**
 * 起一个真子进程，把**它自己看到的** `process.env` 原样倒出来。
 *
 * 为什么不用 `set` / `env` 这些 shell 内建：本项目的 shell 是运行期选出来的
 * （git-bash / pwsh / cmd.exe / sh 四选一，见 proc/shell.ts），这几个名字在四种 shell 下
 * 语义不同（pwsh 里 `env` 根本不是命令）。跑测试的进程自己就是 node，用它必然一致 ——
 * 与 `proc/spawn.test.ts` 同一套手法。
 */
function dumpChildEnv(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const dir = mkdtempSync(path.join(tmpdir(), 'zuse-env-'))
  TEMP_DIRS.push(dir)
  const script = path.join(dir, 'dump-env.cjs')
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.env));\n')
  const raw = `"${process.execPath}" "${script.split('\\').join('/')}"`
  // PowerShell 里以引号开头的一行被当**表达式**解析，直接 ParserError —— 那会让下面
  // 的护栏在 pwsh 机器上静默变成假绿。加 `&`（调用运算符）才是「执行它」；
  // 而 bash 里裸加 `&` 是后台运算符会 syntax error，所以必须按 shell 分。
  const command = getShellLabel() === 'pwsh' ? `& ${raw}` : raw

  return new Promise((resolve, reject) => {
    const child = spawnShellCommand(command, { cwd: process.cwd(), env })
    let out = ''
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8') })
    child.on('error', reject)
    child.on('close', () => {
      try { resolve(JSON.parse(out)) } catch { reject(new Error('子进程没有吐出可解析的 env：' + out.slice(0, 200))) }
    })
  })
}

/** 一个绝不该流进子进程的假凭据。**断言它的值**而不是它的名字 —— 换个名字照样能泄。 */
const SECRET_VALUE = 'sk-zuse-test-MUST-NOT-LEAK-9f3a'

/**
 * **也塞进本进程的 `process.env`**，这一步是刻意的。
 *
 * run 服务最现实的翻车方式不是「白名单漏了一项」，而是「`runEnv` 算得好好的，
 * 调用方忘了把它接到 spawn 上」—— `spawn` 收到 `env: undefined` 会**继承父进程全部环境**，
 * 于是真正的 API key 原样流进子进程。
 *
 * 那种失误下 `runEnv` 的返回值仍然干干净净，**任何对 JS 对象的断言都是绿的**；
 * 只有真起一个进程、读它自己的 `process.env`，才能把它照出来。
 * 变异验证跑过：把 helper 里的 `env` 去掉，本组三条中的泄露那条立刻变红。
 */
process.env.ZUSE_TEST_FAKE_SECRET = SECRET_VALUE
afterAll(() => { delete process.env.ZUSE_TEST_FAKE_SECRET })

const BASE: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SYSTEMROOT: process.env.SystemRoot,
  SystemRoot: process.env.SystemRoot,
  COMSPEC: process.env.ComSpec,
  HOME: process.env.HOME ?? process.env.USERPROFILE,
  JAVA_HOME: 'C:/fake/jdk21',
  npm_config_registry: 'https://example.invalid/',
  ANTHROPIC_API_KEY: SECRET_VALUE,
  GITHUB_TOKEN: SECRET_VALUE,
  SOME_RANDOM_VAR: SECRET_VALUE,
  _VOLTA_TOOL_RECURSION: '1',
}

describe('runEnv —— 子进程真实环境（不是 JS 对象）', () => {
  /**
   * **本文件的核心断言。** spec §5 与 v4 §12 都点名：断言 JS 对象里没有 KEY/TOKEN/SECRET
   * 是**纸糊的** —— 它测不到子进程实际拿到什么。libuv 在 Windows 上还会强补 16 项
   * （实测，见 spec §1.2），只有真起一个进程把它的 process.env 倒出来才算数。
   *
   * 断言的是**值**不是名字：白名单漏了某个变量时，泄露的是那个值；
   * 按名字断言只能覆盖你想得到的那几个名字。
   */
  it('子进程的真实环境里不含任何凭据值', async () => {
    const child = await dumpChildEnv(runEnv(BASE, {}))
    const leaked = Object.entries(child).filter(([, v]) => typeof v === 'string' && v.includes(SECRET_VALUE))
    expect(leaked).toEqual([])
  }, 15000)

  it('子进程真的拿到了通路变量与 runner 声明的变量', async () => {
    const child = await dumpChildEnv(runEnv(BASE, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }))
    expect(child.PATH ?? child.Path).toBeTruthy()          // 没有 PATH 子进程根本起不来
    expect(child.PYTHONUNBUFFERED).toBe('1')
    expect(child.PYTHONIOENCODING).toBe('utf-8')
  }, 15000)

  it('子进程里没有 _VOLTA_TOOL_RECURSION（留着会让 node 找不到）', async () => {
    const child = await dumpChildEnv(runEnv(BASE, {}))
    expect(child._VOLTA_TOOL_RECURSION).toBeUndefined()
  }, 15000)
})

describe('runEnv —— 名单', () => {
  it('语义敏感项放行：JAVA_HOME 砍掉不会崩，会静默换一个 JDK 编译', () => {
    expect(runEnv(BASE, {}).JAVA_HOME).toBe('C:/fake/jdk21')
  })

  /**
   * 设计审计（2026-08-14）：`APPDATA` / `LOCALAPPDATA` 曾经漏在 Windows 名单外，
   * 而它属于「砍掉不会崩、会**结果悄悄不一样**」那一类 —— 比崩了更难查。
   *
   * 实测（绕开用户 `.npmrc`，只让这两个变量当唯一变量）：
   *
   *   npm  cache : 无 → C:\Users\nhn\npm-cache          有 → C:\Users\nhn\AppData\Local\npm-cache
   *   pnpm store : 无 → C:\Users\nhn\.pnpm\store\v3     有 → C:\Users\nhn\AppData\Local\pnpm\store\v3
   *
   * 项目档就是拿来跑 `pnpm install` / 构建的。用错 store = 全量重下，
   * 而 pnpm 的 node_modules 硬链到 store，两个 store 交替用会报「link 到了另一个 store」。
   */
  it('Windows 路径类变量放行（漏了会静默换掉 npm 缓存与 pnpm store）', () => {
    const base = {
      APPDATA: 'C:/Users/x/AppData/Roaming',
      LOCALAPPDATA: 'C:/Users/x/AppData/Local',
      PROGRAMDATA: 'C:/ProgramData',
      PROGRAMFILES: 'C:/Program Files',
    }
    const e = runEnv(base, {})
    expect(e.APPDATA).toBe('C:/Users/x/AppData/Roaming')
    expect(e.LOCALAPPDATA).toBe('C:/Users/x/AppData/Local')
    expect(e.PROGRAMDATA).toBe('C:/ProgramData')
    expect(e.PROGRAMFILES).toBe('C:/Program Files')
  })

  it('补名单没有顺带放行凭据', () => {
    const e = runEnv({
      APPDATA: 'C:/a',
      GH_TOKEN: 'SECRET-1', OSS_ACCESS_KEY: 'SECRET-2', BAILIAN_CODING_PLAN_API_KEY: 'SECRET-3',
    }, {})
    expect(e.APPDATA).toBe('C:/a')
    expect(Object.values(e).join('|')).not.toMatch(/SECRET-/)
  })

  it('npm_config_* 按前缀整组放行', () => {
    const e = runEnv({ npm_config_registry: 'r', npm_config_cache: 'c', npmfoo: 'x' }, {})
    expect(e.npm_config_registry).toBe('r')
    expect(e.npm_config_cache).toBe('c')
    expect(e.npmfoo).toBeUndefined()          // 前缀要完整匹配，不是「以 npm 开头」
  })

  /**
   * `npm_config_*` 是唯一一条整组放行的规则，也就唯一需要 deny 名单。
   * 实测（本机 npm 10.9.4，`.npmrc` 里放假凭据、用 lifecycle script 倒 env）：
   *
   * ```
   * npm_config_* 总数: 15
   *   泄露 → npm_config_https_proxy = http://user:PROXYPWD-LEAK-9f3a@corp.proxy:8080/
   *   泄露 → npm_config_proxy       = http://user:PROXYPWD-LEAK-9f3a@corp.proxy:8080/
   * ```
   *
   * 而 daemon 常常就是 `pnpm dev` / `npm start` 起的 —— 这两个变量正躺在它的
   * `process.env` 里。整组转给「用户点了运行、可能来路不明的代码」= 明文交出代理密码。
   */
  it('npm_config_ 里带凭据的键不放行（代理 URL 明文含密码，实测复现过）', () => {
    const e = runEnv({
      npm_config_registry: 'https://r/',
      npm_config_proxy: 'http://user:PWD@corp:8080/',
      npm_config_https_proxy: 'http://user:PWD@corp:8080/',
      npm_config__authToken: 'tok',
      npm_config_cert: '-----BEGIN CERT-----',
      npm_config_cache: '/c',
    }, {})
    expect(Object.keys(e).sort()).toEqual(['npm_config_cache', 'npm_config_registry'])
    expect(JSON.stringify(e)).not.toContain('PWD')
  })

  it('名单外一律丢掉', () => {
    const e = runEnv({ ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'k', RANDOM_THING: 'k' }, {})
    expect(Object.keys(e)).toEqual([])
  })

  /**
   * 同名键**必须选一个本来就在白名单里的**（这里用 SEMANTIC 组的 NODE_OPTIONS）。
   * 变异测试抓到过一次：原先用的是 `PYTHONIOENCODING`，而它不在名单里、压根进不了
   * 结果对象 —— 于是把实现改成「declared 不覆盖已有键」这条测试**照样绿**，
   * 「覆盖」这个语义从来没被验到。
   */
  it('declared 覆盖 base 里的同名项（runner 说了算）', () => {
    const e = runEnv({ NODE_OPTIONS: '--max-old-space-size=128', PATH: 'p' }, { NODE_OPTIONS: '--enable-source-maps' })
    expect(e.NODE_OPTIONS).toBe('--enable-source-maps')
  })

  it('declared 里的东西不受名单限制 —— 它是 runner 自己声明的，不是继承来的', () => {
    const e = runEnv({}, { JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8' })
    expect(e.JAVA_TOOL_OPTIONS).toBe('-Dfile.encoding=UTF-8')
  })

  it('值为 undefined 的键不产出（别给子进程塞一个空壳变量）', () => {
    const e = runEnv({ PATH: undefined, HOME: 'h' }, {})
    expect('PATH' in e).toBe(false)
    expect(e.HOME).toBe('h')
  })
})

describe('runEnv —— 平台分支', () => {
  /**
   * POSIX 那组在 Windows 上被 libuv 强补的 16 项掩盖着，看不出缺失；
   * 到 Linux/mac 上会直接暴露（curl/python 找不到证书、动态库找不到）。
   */
  it('POSIX 专有通路项：USER / LOGNAME / SSL_CERT_FILE / LD_LIBRARY_PATH', () => {
    const base = { USER: 'u', LOGNAME: 'l', SSL_CERT_FILE: '/etc/ssl/cert.pem', LD_LIBRARY_PATH: '/usr/lib', XDG_CACHE_HOME: '/c' }
    const e = runEnv(base, {}, { platform: 'linux' })
    expect(e).toEqual(base)
  })

  it('Windows 专有通路项：COMSPEC / PATHEXT / SYSTEMROOT', () => {
    const base = { COMSPEC: 'c', PATHEXT: '.EXE', SYSTEMROOT: 'C:/Windows' }
    const e = runEnv(base, {}, { platform: 'win32' })
    expect(e).toEqual(base)
  })

  /**
   * Windows 的环境变量名**大小写不敏感**，真实名字是 `SystemRoot` / `ComSpec` 这种混合写法。
   * 按名单精确匹配会把它们全丢掉 —— 而丢了 SystemRoot，子进程连 cmd 都起不来。
   */
  it('Windows：大小写不敏感匹配，且**保留原始大小写**', () => {
    const e = runEnv({ SystemRoot: 'C:/Windows', ComSpec: 'C:/cmd.exe' }, {}, { platform: 'win32' })
    expect(e.SystemRoot).toBe('C:/Windows')
    expect(e.ComSpec).toBe('C:/cmd.exe')
    expect(Object.keys(e).sort()).toEqual(['ComSpec', 'SystemRoot'])   // 没有被改名成大写
  })

  /** POSIX 上 `PATH` 与 `Path` 是两个不同的变量，不能跟着 Windows 一起大小写不敏感。 */
  it('POSIX：大小写敏感，Path 不等于 PATH', () => {
    const e = runEnv({ Path: 'p' }, {}, { platform: 'linux' })
    expect(e.Path).toBeUndefined()
  })
})
