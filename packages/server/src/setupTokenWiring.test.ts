import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './startServer.js'
import { createSession } from './session/createSession.js'
import { DEFAULT_SESSION_ID, type ServerConfig } from './config.js'
import { fakeClient, fakeSnapshotStore } from './session/testFakes.js'

/**
 * **接线测试** —— 唯一穿过 `startServer` 的一层。
 *
 * 为什么它必须存在：`setupToken` 是**按判据条件传**给 handler 的，而判据本身就是要测的东西。
 * `auth/setupToken.test.ts` 测判据、`http/setupTokenRoutes.test.ts` 测路由，
 * 两者都自己构造入参 —— `startServer` 把判据写反、或者压根忘了传，**它们一条都不会红**。
 *
 * 这正是本仓已修的 iframe sandbox 假绿的形状：三条安全测试牢牢锁住 `SANDBOX_TOKENS` 常量，
 * 而**应用这个常量的那一行**没有任何测试，删掉它三条照样全绿。
 */
let dir: string
const servers: { close(): Promise<void> }[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-wire-')) })
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * 起一个真 daemon（注入 fake-client 会话、不连 MCP —— 同 wsServer.test.ts 的范式）。
 *
 * **`authDir` 必须是临时目录**：`defaultConfig().authDir` 是 `~/.zuse`，照抄它会往开发者
 * 本机真实的 `setup-token` 上写。**`connectMcp:false` 也不能省** —— 否则要去连开发者
 * 真实配置的 MCP server，`wsServer.test.ts` 的注释里记着那造成过「整片随机红」。
 *
 * 参数类型用 `Partial<ServerConfig>` 而不是就手写一个字面量类型：后者会放过键名打错
 * （`allowedHost` 少个 s），而那正好会让下面的测试变成假绿。
 */
async function boot(extra: Partial<ServerConfig> = {}) {
  const { client } = fakeClient([])
  const session = createSession({ sessionId: DEFAULT_SESSION_ID, cwd: dir, client, snapshotStore: fakeSnapshotStore() })
  const server = await startServer(
    { host: '127.0.0.1', port: 0, authDir: dir, tokenTtlSec: 3600, cwd: dir, ...extra },
    { session, connectMcp: false },
  )
  servers.push(server)
  return server
}

const post = (base: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('startServer 的 setup token 接线', () => {
  /** 默认本机开发：不能被这次改动加一步摩擦，也不该在 authDir 里留一个 token 文件。 */
  it('回环形态：不生成 token，setup 照常成功', async () => {
    const s = await boot()
    expect(existsSync(join(dir, 'setup-token'))).toBe(false)
    expect((await post(s.url, '/api/auth/setup', { password: 'pw' })).status).toBe(200)
  })

  /**
   * 回环 + `--trust-proxy` = 前面挂了隧道 = 公网可达。**判据漏掉这一条就等于白做**，
   * 因为这恰恰是 `docs/remote-access.md` 推荐的形态。
   */
  it('回环 + trustProxy：要 token，且 token 能从 authDir 的文件里取回', async () => {
    const s = await boot({ trustProxy: true })

    const denied = await post(s.url, '/api/auth/setup', { password: 'pw' })
    expect(denied.status).toBe(403)
    expect((await denied.json()).error.code).toBe('setup_token_required')

    // 后台 / systemd / Windows 服务形态看不到 stdout —— 没有这个文件，
    // 「重启再看一次横幅」是死循环（重启只会换一个同样看不见的新 token）。
    const tokenPath = join(dir, 'setup-token')
    expect(existsSync(tokenPath)).toBe(true)
    const token = readFileSync(tokenPath, 'utf8').trim()
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)

    expect((await post(s.url, '/api/auth/setup', { password: 'pw', setupToken: token })).status).toBe(200)
    expect((await post(s.url, '/api/auth/login', { password: 'pw' })).status).toBe(200)
  })

  it('回环 + allowedHosts（隧道域名已声明）也要 token', async () => {
    const s = await boot({ allowedHosts: ['x.trycloudflare.com'] })
    expect((await post(s.url, '/api/auth/setup', { password: 'pw' })).status).toBe(403)
  })

  /**
   * **同机第二个 daemon 不许删掉第一个正在用的 token 文件。**
   *
   * 这条是评审实测复现出来的真 bug：清理陈旧文件的分支原本写成「不是暴露形态就删」，
   * 而 token 文件按 authDir 命名、不按实例。共用默认 `~/.zuse` 的两个 daemon 一起跑时，
   * 后起的本机那个会把先起的暴露那个的**活 token** 删掉 ——
   * 正好打死落盘存在的唯一理由（headless 形态看不到横幅，文件没了就永久取不回）。
   */
  it('同一 authDir 上再起一个本机 daemon，不会删掉暴露 daemon 的活 token', async () => {
    const exposed = await boot({ trustProxy: true })
    const tokenPath = join(dir, 'setup-token')
    const token = readFileSync(tokenPath, 'utf8').trim()

    await boot() // 第二个：本机形态，共用同一个 authDir

    expect(existsSync(tokenPath)).toBe(true)
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(token)
    // 而且它仍然管用 —— 只断言文件在会放过「文件在但内容被冲掉了」
    expect((await post(exposed.url, '/api/auth/setup', { password: 'pw', setupToken: token })).status).toBe(200)
  })

  it('status 报 setupTokenRequired，且不回 token 本体', async () => {
    const s = await boot({ trustProxy: true })
    const text = await (await fetch(`${s.url}/api/auth/status`)).text()
    expect(JSON.parse(text).setupTokenRequired).toBe(true)
    expect(text).not.toContain(readFileSync(join(dir, 'setup-token'), 'utf8').trim())
  })
})
