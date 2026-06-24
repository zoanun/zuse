export interface ParsedArgs {
  port?: number
  host?: string
  setPassword: boolean
}

/**
 * Pure CLI argument parser for the zuse-server bin.
 * Recognizes: --port <n>, --host <h>, --set-password.
 * An invalid --port value (non-integer / non-positive) is ignored (leaves port undefined).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { setPassword: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--set-password') {
      result.setPassword = true
    } else if (arg === '--port') {
      const raw = argv[++i]
      const n = Number(raw)
      if (raw !== undefined && Number.isInteger(n) && n >= 0 && n <= 65535) {
        result.port = n
      }
    } else if (arg === '--host') {
      const h = argv[++i]
      if (h !== undefined) result.host = h
    }
  }
  return result
}
