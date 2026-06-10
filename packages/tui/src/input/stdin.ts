import {
  parseMultipleKeypresses,
  INITIAL_STATE,
  type KeyParseState,
} from './parseKeypress.js'
import { enterInputMode, leaveInputMode } from './protocol.js'
import type { InputBus } from './inputBus.js'

/** process.stdin 所需能力的最小子集(便于注入假流单测)。 */
export interface StdinLike {
  isTTY?: boolean
  setRawMode?(mode: boolean): void
  setEncoding?(encoding: string): void
  resume(): void
  pause(): void
  on(event: 'data', listener: (chunk: Buffer | string) => void): void
  off(event: 'data', listener: (chunk: Buffer | string) => void): void
}

export interface StdoutLike {
  write(data: string): void
}

export interface StdinManagerOptions {
  stdin: StdinLike
  stdout: StdoutLike
  bus: InputBus
}

export interface StdinManager {
  start(): void
  stop(): void
}

/**
 * 接管 stdin:解析按键并派发到 bus,管理 raw mode 与协议的进出。
 * 非 TTY 或不支持 raw mode 时降级——不接管、不推协议(见 spec §9)。
 */
export function createStdinManager(opts: StdinManagerOptions): StdinManager {
  const { stdin, stdout, bus } = opts
  let state: KeyParseState = INITIAL_STATE
  let started = false
  let didActivate = false

  const canRaw = (): boolean =>
    !!stdin.isTTY && typeof stdin.setRawMode === 'function'

  const onData = (chunk: Buffer | string): void => {
    const [keys, next] = parseMultipleKeypresses(state, chunk)
    state = next
    for (const k of keys) bus.dispatch(k)
  }

  const cleanup = (): void => {
    manager.stop()
  }

  const manager: StdinManager = {
    start(): void {
      if (started) return
      started = true
      // 非 TTY / 不支持 raw mode:降级,didActivate 保持 false,stop 时也不做还原。
      if (!canRaw()) return
      didActivate = true
      stdin.setRawMode!(true)
      stdin.setEncoding?.('utf8')
      stdin.resume()
      enterInputMode((s) => stdout.write(s))
      stdin.on('data', onData)
      // 异常/退出/信号都要还原终端,避免留在坏状态。
      process.once('exit', cleanup)
      process.once('SIGINT', cleanup)
      process.once('SIGTERM', cleanup)
    },

    stop(): void {
      if (!started) return
      started = false
      // 从未真正接管(非 TTY 降级)时无需还原,直接返回——与 start 决策对称。
      if (!didActivate) return
      didActivate = false
      // flush 半截序列,避免吞字符。
      const [keys] = parseMultipleKeypresses(state, null)
      for (const k of keys) bus.dispatch(k)
      state = INITIAL_STATE
      stdin.off('data', onData)
      leaveInputMode((s) => stdout.write(s))
      stdin.setRawMode!(false)
      process.removeListener('exit', cleanup)
      process.removeListener('SIGINT', cleanup)
      process.removeListener('SIGTERM', cleanup)
    },
  }

  return manager
}
