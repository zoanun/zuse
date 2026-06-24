#!/usr/bin/env node
import { join } from 'node:path'
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
  process.on('SIGINT', () => {
    void server.close().then(() => process.exit(0))
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
