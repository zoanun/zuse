import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as path from 'node:path'

const execFile = promisify(execFileCb)

/** Shared options for all git subprocesses: prevent credential prompts, hide console on Windows. */
const GIT_EXEC_OPTS = {
  timeout: 30_000,
  windowsHide: true,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
  },
} as const

export interface WorktreeInfo {
  worktreePath: string
  worktreeBranch: string
  headCommit: string
  gitRoot: string
}

/**
 * Find the git repository root from `cwd`.
 * Returns null if `cwd` is not inside a git repository.
 */
export function findGitRoot(cwd: string): string | null {
  try {
    const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: 10_000,
      windowsHide: true,
      encoding: 'utf-8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return result.trim()
  } catch {
    return null
  }
}

/**
 * Ensure `.zuse/worktrees/` is listed in `.git/info/exclude` so that
 * worktree directories do not pollute `git status` in the main repo.
 */
export async function ensureWorktreesDirExcluded(gitRoot: string): Promise<void> {
  const excludePattern = '.zuse/worktrees/'
  const excludePath = path.join(gitRoot, '.git', 'info', 'exclude')

  try {
    // Ensure the .git/info directory exists
    const infoDir = path.dirname(excludePath)
    await fs.promises.mkdir(infoDir, { recursive: true })

    let content = ''
    try {
      content = await fs.promises.readFile(excludePath, 'utf-8')
    } catch {
      // File doesn't exist yet -- we'll create it
    }

    // Check if already excluded
    if (content.includes(excludePattern)) return

    // Append the exclude pattern
    const newline = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
    await fs.promises.appendFile(excludePath, `${newline}${excludePattern}\n`, 'utf-8')
  } catch {
    // Best-effort: if we can't write the exclude file, proceed anyway.
    // The worktrees will show in git status but that's not fatal.
  }
}

/**
 * Create a worktree under `<gitRoot>/.zuse/worktrees/<slug>`.
 * The branch name is `worktree-<slug>`.
 *
 * Uses `-B` (not `-b`) to reset the branch if it already exists from a leaked worktree.
 */
export async function createWorktree(
  gitRoot: string,
  slug: string,
): Promise<WorktreeInfo> {
  // Validate slug: alphanumeric + hyphens only, no path traversal
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`Invalid worktree slug: "${slug}"`)
  }

  const worktreePath = path.join(gitRoot, '.zuse', 'worktrees', slug)
  const worktreeBranch = `worktree-${slug}`

  // Ensure .zuse/worktrees/ is excluded from git status
  await ensureWorktreesDirExcluded(gitRoot)

  // Ensure parent directory exists
  await fs.promises.mkdir(path.join(gitRoot, '.zuse', 'worktrees'), { recursive: true })

  // Get current HEAD sha before creating the worktree
  const { stdout: headSha } = await execFile('git', ['rev-parse', 'HEAD'], {
    ...GIT_EXEC_OPTS,
    cwd: gitRoot,
  })
  const headCommit = headSha.trim()

  // Create the worktree. -B resets the branch if it already exists (leaked worktree).
  await execFile(
    'git',
    ['worktree', 'add', '-B', worktreeBranch, worktreePath, 'HEAD'],
    { ...GIT_EXEC_OPTS, cwd: gitRoot },
  )

  return {
    worktreePath,
    worktreeBranch,
    headCommit,
    gitRoot,
  }
}

/**
 * True if the worktree has uncommitted changes or new commits since `headCommit`.
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  // Check for uncommitted changes (staged or unstaged)
  const { stdout: status } = await execFile(
    'git',
    ['status', '--porcelain'],
    { ...GIT_EXEC_OPTS, cwd: worktreePath },
  )
  if (status.trim().length > 0) return true

  // Check for new commits since headCommit
  const { stdout: count } = await execFile(
    'git',
    ['rev-list', '--count', `${headCommit}..HEAD`],
    { ...GIT_EXEC_OPTS, cwd: worktreePath },
  )
  if (parseInt(count.trim(), 10) > 0) return true

  return false
}

/**
 * Return `git diff --stat` from `headCommit` to the current worktree state.
 * Includes both committed and uncommitted changes.
 */
export async function worktreeDiffStat(
  worktreePath: string,
  headCommit: string,
): Promise<string> {
  // First get the diff stat of committed changes
  const { stdout: committedStat } = await execFile(
    'git',
    ['diff', '--stat', headCommit],
    { ...GIT_EXEC_OPTS, cwd: worktreePath },
  )
  return committedStat.trim()
}

/**
 * Remove a worktree directory and delete its temporary branch.
 * Best-effort: returns false if cleanup partially or fully failed, true if clean.
 */
export async function removeWorktree(
  worktreePath: string,
  worktreeBranch: string,
  gitRoot: string,
): Promise<boolean> {
  let clean = true

  // Remove the worktree
  try {
    await execFile(
      'git',
      ['worktree', 'remove', '--force', worktreePath],
      { ...GIT_EXEC_OPTS, cwd: gitRoot },
    )
  } catch {
    clean = false
    // Fallback: try to remove the directory manually
    try {
      await fs.promises.rm(worktreePath, { recursive: true, force: true })
      // Prune stale worktree entries
      await execFile('git', ['worktree', 'prune'], { ...GIT_EXEC_OPTS, cwd: gitRoot })
    } catch {
      // Nothing more we can do
    }
  }

  // Delete the branch
  try {
    await execFile(
      'git',
      ['branch', '-D', worktreeBranch],
      { ...GIT_EXEC_OPTS, cwd: gitRoot },
    )
  } catch {
    clean = false
  }

  return clean
}
