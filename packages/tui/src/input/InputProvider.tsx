import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react'
import { stdin as processStdin, stdout as processStdout } from 'node:process'
import { createInputBus, type InputBus } from './inputBus.js'
import { createStdinManager, type StdinLike } from './stdin.js'

const InputBusContext = createContext<InputBus | null>(null)

/** 取当前 InputBus;必须在 <InputProvider> 内调用。 */
export function useInputBus(): InputBus {
  const bus = useContext(InputBusContext)
  if (!bus) throw new Error('useInputBus 必须在 <InputProvider> 内使用')
  return bus
}

interface InputProviderProps {
  children: ReactNode
}

/**
 * 输入子系统的根 Provider:挂载时接管真实 process.stdin,卸载时还原。
 * Ink 已被入口喂哑 stdin,故这里独占真实键盘输入,不与 Ink 抢。
 */
export function InputProvider({ children }: InputProviderProps): ReactNode {
  const bus = useMemo(() => createInputBus(), [])
  useEffect(() => {
    const mgr = createStdinManager({
      // processStdin 的 setEncoding 签名更严格(BufferEncoding | undefined),
      // 而 StdinLike 期望 (encoding: string) => void;用 as 做兼容断言。
      stdin: processStdin as StdinLike,
      stdout: processStdout,
      bus,
    })
    mgr.start()
    return () => mgr.stop()
  }, [bus])
  return (
    <InputBusContext.Provider value={bus}>{children}</InputBusContext.Provider>
  )
}
