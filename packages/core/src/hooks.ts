import { execSync } from 'node:child_process'
import type { HookRule } from './types.js'

export type HookPhase = 'preToolUse' | 'postToolUse'

/** Max wall-clock a single hook command may run before it's killed. */
const HOOK_TIMEOUT_MS = 10000

export interface HookEnv {
  toolName: string
  toolInput: unknown
  cwd: string
}

function matchesRule(rule: HookRule, toolName: string): boolean {
  return rule.tool === '*' || rule.tool === toolName
}

export function runHooks(
  rules: HookRule[] | undefined,
  env: HookEnv,
): { warnings: string[] } {
  const warnings: string[] = []
  if (!rules || rules.length === 0) return { warnings }

  const matching = rules.filter((r) => matchesRule(r, env.toolName))
  for (const rule of matching) {
    try {
      execSync(rule.command, {
        cwd: env.cwd,
        timeout: HOOK_TIMEOUT_MS,
        stdio: 'pipe',
        env: {
          ...process.env,
          ZUSE_TOOL_NAME: env.toolName,
          ZUSE_TOOL_INPUT: JSON.stringify(env.toolInput),
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`Hook "${rule.command}" failed: ${msg}`)
    }
  }

  return { warnings }
}
