#!/usr/bin/env node
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { startServer } from './startServer.js'
import { defaultConfig } from './config.js'
import { PasswordStore } from './auth/passwordStore.js'
import { LocalPasswordAuth } from './auth/authProvider.js'
import { parseArgs } from './cliArgs.js'

/** Read a single line from stdin. Resolves with the line (trailing newline stripped),
 *  or undefined if the stream ends without producing any data. Does not hang: when the
 *  stdin stream ends with no input, it resolves undefined rather than waiting forever. */
function readLine(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buf = ''
    let settled = false
    const stdin = process.stdin
    const done = (val: string | undefined): void => {
      if (settled) return
      settled = true
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      try { stdin.pause() } catch { /* best-effort */ }
      resolve(val)
    }
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) done(buf.slice(0, nl).replace(/\r$/, ''))
    }
    const onEnd = (): void => {
      const line = buf.replace(/\r?\n$/, '')
      done(line.length > 0 ? line : undefined)
    }
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.on('end', onEnd)
    try { stdin.resume() } catch { /* best-effort */ }
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cfg = {
    ...defaultConfig(),
    cwd: process.env.INIT_CWD ?? process.cwd(),
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...(args.host !== undefined ? { host: args.host } : {}),
    ...(args.tlsCert !== undefined ? { tlsCert: args.tlsCert } : {}),
    ...(args.tlsKey !== undefined ? { tlsKey: args.tlsKey } : {}),
    ...(args.trustProxy ? { trustProxy: true } : {}),
    // CLI 给了就**整体覆盖** env（不合并）—— 理由见 ServerConfig.allowedHosts
    ...(args.allowedHosts !== undefined ? { allowedHosts: args.allowedHosts } : {}),
  }

  // A2:TLS 配置 fail fast —— 安全配置绝不静默降级。
  // 「以为在跑 https、实际是明文」比直接崩掉危险得多,所以宁可退出。
  if (!!cfg.tlsCert !== !!cfg.tlsKey) {
    console.error('[zuse-server] --tls-cert 与 --tls-key 必须同时提供')
    process.exit(1)
  }
  for (const p of [cfg.tlsCert, cfg.tlsKey]) {
    if (p !== undefined && !existsSync(p)) {
      console.error(`[zuse-server] TLS 文件不存在:${p}`)
      process.exit(1)
    }
  }

  if (args.setPassword) {
    const auth = new LocalPasswordAuth(new PasswordStore(cfg.authDir), cfg.tokenTtlSec)
    const authFilePath = join(cfg.authDir, 'web-auth.json')
    if (await auth.isConfigured()) {
      console.error(`Password already set. To reset, delete ${authFilePath} and run --set-password again.`)
      process.exit(0)
    }
    if (process.stdin.isTTY) {
      console.error('Enter new web password (input is not hidden), then press Enter:')
    }
    const pw = await readLine()
    if (!pw) {
      console.error('No password provided on stdin. Usage: zuse-server --set-password  (then type the password and press Enter)')
      process.exit(1)
    }
    await auth.setup(pw)
    console.log('Web password set.')
    process.exit(0)
  }

  const server = await startServer(cfg)
  console.log('zuse-server listening at ' + server.url)
  // **SIGTERM 也要收**（原来只有 SIGINT）：`server.close()` 里现在负责把在跑的子进程
  // 收掉，只挂 SIGINT 的话，只有「前台 Ctrl+C」这一条路会清场。
  //
  // **已知限制，别以为这样就万无一失**：Windows 上 `taskkill /F` **不发信号、直接终止进程**，
  // 这两个处理器一个都不会跑 —— 那种情况下在跑的子进程会变孤儿。
  //
  // **别写「片段档有墙钟兜底」——那是错的**（这里原先就是这么写的，评审实测推翻）：
  // 墙钟是本进程内的 `setTimeout`，本进程被强杀，墙钟跟着没了，孙进程照跑。
  // 实测：只杀父进程，4 秒后孙进程的心跳仍在推进。
  //
  // 真正的兜底在**杀的那一侧**：`taskkill` 必须带 `/T`（本仓 `.claude/skills/restart`
  // 已经加上）。而且**只能在杀之前带**——父进程一死进程树就断了，事后补跑 `/T`
  // 只会得到 `process not found`，孤儿只能按命令行去捞。
  //
  // 「pid 落盘 + 启动时回收」不要照做：落的是 cmd.exe 包装器的 pid，它先死、
  // pid 可能被系统回收，重启时对它 `taskkill /T /F` 会误杀无辜进程。
  const shutdown = (): void => { void server.close().then(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
