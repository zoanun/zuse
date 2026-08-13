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
  // **已知限制，别以为这样就万无一失**：Windows 上 `taskkill /F`（以及本仓 restart 技能
  // 用的就是它）**不发信号、直接终止进程**，这两个处理器一个都不会跑 —— 那种情况下
  // 在跑的子进程仍会变孤儿。片段档有 300 秒墙钟兜底；项目档（步骤 4，无墙钟 +
  // 断连不杀）真到那时得另想办法（比如把 pid 落盘、启动时回收）。
  const shutdown = (): void => { void server.close().then(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
