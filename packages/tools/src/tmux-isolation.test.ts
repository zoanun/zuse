import { describe, it, expect, beforeEach } from 'vitest'
import {
  getZuseTmuxSocketName,
  getZuseTmuxEnv,
  isTmuxSocketInitialized,
  isTmuxCommand,
  resetTmuxStateForTest,
} from './tmux-isolation.js'

beforeEach(() => resetTmuxStateForTest())

describe('isTmuxCommand（整词匹配，宁可错触发不可漏）', () => {
  const yes = [
    'tmux',
    'tmux new-session -d',
    'tmux kill-server',
    'cd x && tmux ls',
    'foo; tmux attach',
    'a | tmux',
    'xargs tmux',
    '(tmux ls)',
    'echo "use tmux later"', // 出现整词 tmux 即从宽触发(多开隔离 server 比漏开安全)
  ]
  const no = [
    'echo tmuxinator', // tmux 是更大单词的子串
    'mytmux start',
    'ls -la',
    'echo hello',
  ]
  for (const c of yes) it(`识别为 tmux 命令：${c}`, () => expect(isTmuxCommand(c)).toBe(true))
  for (const c of no) it(`不识别为 tmux 命令：${c}`, () => expect(isTmuxCommand(c)).toBe(false))
})

describe('套接字状态', () => {
  it('socket 名形如 zuse-<pid>', () => {
    expect(getZuseTmuxSocketName()).toBe(`zuse-${process.pid}`)
  })
  it('未初始化时 env 为 null、isInitialized 为 false', () => {
    expect(getZuseTmuxEnv()).toBeNull()
    expect(isTmuxSocketInitialized()).toBe(false)
  })
})
