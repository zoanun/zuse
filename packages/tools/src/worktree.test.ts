import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  findGitRoot,
  createWorktree,
  hasWorktreeChanges,
  worktreeDiffStat,
  removeWorktree,
  ensureWorktreesDirExcluded,
} from './worktree.js'

/** Helper: run a git command synchronously in a given cwd. */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
  }).trim()
}

/** Create a temporary git repository for testing. Returns the repo root path. */
function createTempRepo(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zuse-wt-test-'))
  git(['init'], tmpDir)
  git(['config', 'user.email', 'test@test.com'], tmpDir)
  git(['config', 'user.name', 'Test'], tmpDir)
  // Create an initial commit so HEAD is valid
  const filePath = path.join(tmpDir, 'README.md')
  fs.writeFileSync(filePath, '# Test\n')
  git(['add', '.'], tmpDir)
  git(['commit', '-m', 'initial commit'], tmpDir)
  return tmpDir
}

/** Remove a temporary directory (best-effort). */
function removeTempDir(dirPath: string): void {
  try {
    // Prune any worktrees first to avoid locked-file issues on Windows
    try {
      git(['worktree', 'prune'], dirPath)
    } catch { /* ignore */ }
    fs.rmSync(dirPath, { recursive: true, force: true })
  } catch { /* ignore */ }
}

describe('findGitRoot', () => {
  let repoDir: string

  beforeEach(() => { repoDir = createTempRepo() })
  afterEach(() => { removeTempDir(repoDir) })

  it('returns the repo root when cwd is the root', () => {
    const result = findGitRoot(repoDir)
    expect(result).toBeTruthy()
    // Normalize paths for cross-platform comparison
    expect(path.normalize(result!)).toBe(path.normalize(repoDir))
  })

  it('returns the repo root from a subdirectory', () => {
    const subDir = path.join(repoDir, 'src')
    fs.mkdirSync(subDir)
    const result = findGitRoot(subDir)
    expect(result).toBeTruthy()
    expect(path.normalize(result!)).toBe(path.normalize(repoDir))
  })

  it('returns null when cwd is not in a git repo', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zuse-no-git-'))
    try {
      const result = findGitRoot(tmpDir)
      expect(result).toBeNull()
    } finally {
      removeTempDir(tmpDir)
    }
  })
})

describe('ensureWorktreesDirExcluded', () => {
  let repoDir: string

  beforeEach(() => { repoDir = createTempRepo() })
  afterEach(() => { removeTempDir(repoDir) })

  it('adds .zuse/worktrees/ to .git/info/exclude', async () => {
    await ensureWorktreesDirExcluded(repoDir)

    const excludePath = path.join(repoDir, '.git', 'info', 'exclude')
    const content = fs.readFileSync(excludePath, 'utf-8')
    expect(content).toContain('.zuse/worktrees/')
  })

  it('does not duplicate the pattern on repeated calls', async () => {
    await ensureWorktreesDirExcluded(repoDir)
    await ensureWorktreesDirExcluded(repoDir)

    const excludePath = path.join(repoDir, '.git', 'info', 'exclude')
    const content = fs.readFileSync(excludePath, 'utf-8')
    const matches = content.match(/\.zuse\/worktrees\//g)
    expect(matches).toHaveLength(1)
  })
})

describe('createWorktree', () => {
  let repoDir: string

  beforeEach(() => { repoDir = createTempRepo() })
  afterEach(() => {
    // Clean up any worktrees before removing the temp dir
    try { git(['worktree', 'prune'], repoDir) } catch { /* ignore */ }
    removeTempDir(repoDir)
  })

  it('creates a worktree with expected path and branch', async () => {
    const info = await createWorktree(repoDir, 'agent-abcd1234')

    expect(info.worktreePath).toBe(path.join(repoDir, '.zuse', 'worktrees', 'agent-abcd1234'))
    expect(info.worktreeBranch).toBe('worktree-agent-abcd1234')
    expect(info.gitRoot).toBe(repoDir)
    expect(info.headCommit).toMatch(/^[0-9a-f]{40}$/)

    // The worktree directory should exist and contain the repo files
    expect(fs.existsSync(info.worktreePath)).toBe(true)
    expect(fs.existsSync(path.join(info.worktreePath, 'README.md'))).toBe(true)

    // The branch should exist
    const branches = git(['branch', '--list', info.worktreeBranch], repoDir)
    expect(branches).toContain(info.worktreeBranch)

    // Clean up
    await removeWorktree(info.worktreePath, info.worktreeBranch, repoDir)
  })

  it('rejects slugs with invalid characters', async () => {
    await expect(createWorktree(repoDir, 'agent/../hack')).rejects.toThrow('Invalid worktree slug')
    await expect(createWorktree(repoDir, 'UPPER_CASE')).rejects.toThrow('Invalid worktree slug')
    await expect(createWorktree(repoDir, 'has space')).rejects.toThrow('Invalid worktree slug')
  })

  it('handles -B for existing branches from leaked worktrees', async () => {
    // Create first worktree, then remove it leaving the branch
    const info1 = await createWorktree(repoDir, 'agent-leaked01')
    // Remove worktree but keep the branch (simulate a leak)
    git(['worktree', 'remove', '--force', info1.worktreePath], repoDir)
    // Branch still exists -- createWorktree should not fail thanks to -B
    const info2 = await createWorktree(repoDir, 'agent-leaked01')
    expect(fs.existsSync(info2.worktreePath)).toBe(true)

    // Clean up
    await removeWorktree(info2.worktreePath, info2.worktreeBranch, repoDir)
  })
})

describe('hasWorktreeChanges', () => {
  let repoDir: string

  beforeEach(() => { repoDir = createTempRepo() })
  afterEach(() => {
    try { git(['worktree', 'prune'], repoDir) } catch { /* ignore */ }
    removeTempDir(repoDir)
  })

  it('returns false for a clean worktree', async () => {
    const info = await createWorktree(repoDir, 'agent-clean001')
    const changed = await hasWorktreeChanges(info.worktreePath, info.headCommit)
    expect(changed).toBe(false)

    await removeWorktree(info.worktreePath, info.worktreeBranch, repoDir)
  })

  it('returns true when there are uncommitted changes', async () => {
    const info = await createWorktree(repoDir, 'agent-dirty001')
    // Create a new file in the worktree
    fs.writeFileSync(path.join(info.worktreePath, 'new-file.txt'), 'hello')
    git(['add', 'new-file.txt'], info.worktreePath)

    const changed = await hasWorktreeChanges(info.worktreePath, info.headCommit)
    expect(changed).toBe(true)

    await removeWorktree(info.worktreePath, info.worktreeBranch, repoDir)
  })

  it('returns true when there are new commits', async () => {
    const info = await createWorktree(repoDir, 'agent-commit1')
    // Create a file and commit it
    fs.writeFileSync(path.join(info.worktreePath, 'committed.txt'), 'world')
    git(['add', 'committed.txt'], info.worktreePath)
    git(['commit', '-m', 'sub-agent commit'], info.worktreePath)

    const changed = await hasWorktreeChanges(info.worktreePath, info.headCommit)
    expect(changed).toBe(true)

    await removeWorktree(info.worktreePath, info.worktreeBranch, repoDir)
  })
})

describe('worktreeDiffStat', () => {
  let repoDir: string

  beforeEach(() => { repoDir = createTempRepo() })
  afterEach(() => {
    try { git(['worktree', 'prune'], repoDir) } catch { /* ignore */ }
    removeTempDir(repoDir)
  })

  it('returns diff stat for changes in the worktree', async () => {
    const info = await createWorktree(repoDir, 'agent-diff0001')
    // Make a change and commit
    fs.writeFileSync(path.join(info.worktreePath, 'README.md'), '# Updated\n\nNew content.\n')
    git(['add', 'README.md'], info.worktreePath)
    git(['commit', '-m', 'update readme'], info.worktreePath)

    const stat = await worktreeDiffStat(info.worktreePath, info.headCommit)
    expect(stat).toContain('README.md')
    expect(stat).toMatch(/\d+ insertion/)

    await removeWorktree(info.worktreePath, info.worktreeBranch, repoDir)
  })

  it('returns empty string for a clean worktree', async () => {
    const info = await createWorktree(repoDir, 'agent-nochg01')
    const stat = await worktreeDiffStat(info.worktreePath, info.headCommit)
    expect(stat).toBe('')

    await removeWorktree(info.worktreePath, info.worktreeBranch, repoDir)
  })
})

describe('removeWorktree', () => {
  let repoDir: string

  beforeEach(() => { repoDir = createTempRepo() })
  afterEach(() => {
    try { git(['worktree', 'prune'], repoDir) } catch { /* ignore */ }
    removeTempDir(repoDir)
  })

  it('removes the worktree directory and branch', async () => {
    const info = await createWorktree(repoDir, 'agent-remove01')
    expect(fs.existsSync(info.worktreePath)).toBe(true)

    const result = await removeWorktree(info.worktreePath, info.worktreeBranch, repoDir)
    expect(result).toBe(true)
    expect(fs.existsSync(info.worktreePath)).toBe(false)

    // Branch should be gone
    const branches = git(['branch', '--list', info.worktreeBranch], repoDir)
    expect(branches).toBe('')
  })

  it('returns false but does not throw for an already-removed worktree', async () => {
    const info = await createWorktree(repoDir, 'agent-double01')
    // Remove once
    await removeWorktree(info.worktreePath, info.worktreeBranch, repoDir)
    // Remove again -- should not throw
    const result = await removeWorktree(info.worktreePath, info.worktreeBranch, repoDir)
    expect(result).toBe(false)
  })
})
