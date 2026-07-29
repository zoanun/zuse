import { describe, it, expect } from 'vitest'
import { parseArgs } from './cliArgs.js'

describe('parseArgs', () => {
  it('parses --port and --host', () => {
    expect(parseArgs(['--port', '5000', '--host', '0.0.0.0'])).toEqual({
      port: 5000,
      host: '0.0.0.0',
      setPassword: false,
    })
  })

  it('parses --set-password', () => {
    expect(parseArgs(['--set-password'])).toEqual({ setPassword: true })
  })

  it('defaults with no args', () => {
    expect(parseArgs([])).toEqual({ setPassword: false })
  })

  it('ignores an invalid --port value (leaves port undefined)', () => {
    expect(parseArgs(['--port', 'abc'])).toEqual({ setPassword: false })
  })

  it('parses combined flags including --set-password', () => {
    expect(parseArgs(['--port', '8080', '--set-password'])).toEqual({
      port: 8080,
      setPassword: true,
    })
  })

  // A2 远程访问
  it('parses --tls-cert / --tls-key / --trust-proxy', () => {
    expect(parseArgs(['--tls-cert', 'c.pem', '--tls-key', 'k.pem', '--trust-proxy'])).toEqual({
      setPassword: false,
      tlsCert: 'c.pem',
      tlsKey: 'k.pem',
      trustProxy: true,
    })
  })

  it('TLS/代理参数缺省时不出现在结果里(与 port/host 同风格)', () => {
    const a = parseArgs([])
    expect(a.tlsCert).toBeUndefined()
    expect(a.tlsKey).toBeUndefined()
    expect(a.trustProxy).toBeUndefined()
  })

  it('只给 --tls-cert 也照常解析(成对校验由 bin 做 fail fast)', () => {
    expect(parseArgs(['--tls-cert', 'only.pem'])).toEqual({ setPassword: false, tlsCert: 'only.pem' })
  })
})
