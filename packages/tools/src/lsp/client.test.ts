import { describe, it, expect } from 'vitest'
import { LspClient, LspError } from './client.js'
import type { LanguageServerConfig } from './servers.js'

// 一个命令绝不存在于 PATH 的语言配置，用来验证「没装 server」的失败路径。
const MISSING: LanguageServerConfig = {
  id: 'fake',
  extensions: ['.fake'],
  command: 'zuse-definitely-missing-server-xyz',
  args: ['--stdio'],
  ready: 'immediate',
  installHint: 'npm i -g zuse-fake-server',
}

describe('LspClient.start — 缺失服务器快速失败', () => {
  it('命令不在 PATH 上时立即抛带 installHint 的 LspError，而非耗尽 initialize 超时', async () => {
    const signal = new AbortController().signal
    const t0 = Date.now()
    const err = await LspClient.start(MISSING, process.cwd(), undefined, signal).catch((e: unknown) => e)
    // 必须带上 installHint（让工具层把安装命令回喂给模型/用户）
    expect(err).toBeInstanceOf(LspError)
    expect((err as LspError).installHint).toBe('npm i -g zuse-fake-server')
    // 必须是 spawn 前的 pre-check 快速失败（亚秒级），而不是死等到 30s 的 initialize 超时
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})
