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
})
