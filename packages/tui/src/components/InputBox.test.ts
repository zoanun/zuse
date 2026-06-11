import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'
import { InputBox } from './InputBox.js'
import { InputProvider } from '../input/InputProvider.js'
import type { StdinLike, StdoutLike } from '../input/stdin.js'
import type { CommandInfo } from '../commands/types.js'

const COMMANDS: CommandInfo[] = [
  { name: 'help', description: '列出所有可用命令' },
  { name: 'clear', description: '清空对话历史' },
  { name: 'config', description: '显示当前生效配置' },
  { name: 'save', description: '保存当前对话', takesArgs: true },
  { name: 'model', description: '查看或切换模型' },
]

// stdin 写入后让 ink 处理一拍再断言。
// 真实等待 60ms,需大于 ESC 超时窗口(ESC_FLUSH_TIMEOUT_MS=50ms):孤立 ESC 需等满
// 该窗口才会被 flush 为 escape 键,等待不足会导致依赖 Esc 的用例漂移失败。
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

/**
 * 仿 ink-testing-library 的 Stdin/Stdout，但把 stdin 同时暴露给
 * InputProvider(useInput shim)使用，使测试里的 stdin.write() 能触发组件回调。
 * isTTY=true 让 StdinManager 真正接管（不降级），setRawMode/setEncoding/resume 均空实现。
 */
class FakeStdin extends EventEmitter implements StdinLike {
  isTTY = true as const
  write(data: string): void {
    this.emit('data', data)
  }
  setRawMode(): void { /* no-op */ }
  setEncoding(): void { /* no-op */ }
  resume(): void { /* no-op */ }
  pause(): void { /* no-op */ }
}

class FakeStdout extends EventEmitter implements StdoutLike {
  frames: string[] = []
  _last: string | undefined
  write = (s: string): void => {
    this.frames.push(s)
    this._last = s
  }
  get columns(): number { return 100 }
}

// 渲染一个 InputBox；不用 ink-testing-library（它创建自己的 stdin，不可注入），
// 改用 ink 直接渲染 + 共享 FakeStdin，使 InputProvider 和 Ink 监听同一个 stdin。
async function mount(onSubmit: (text: string, displayText?: string, pasteFiles?: Record<number, string>) => void = () => {}) {
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  const instance = inkRender(
    createElement(
      InputProvider,
      { stdin, stdout },
      createElement(InputBox, { onSubmit, isDisabled: false, commands: COMMANDS }),
    ),
    {
      // Ink 也拿到同一个 stdin：Ink 内部监听 'data' 做焦点/自身 useInput（此处哑流）；
      // 但我们的 shim 不走 Ink，走 InputProvider，所以这里传哑流即可。
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await tick()
  return {
    stdin,
    lastFrame: () => stdout._last,
    unmount: () => {
      instance.unmount()
      instance.cleanup()
    },
  }
}

// 终端控制序列。
const ENTER = '\r'
const TAB = '\t'
const ESC = ''
const DOWN = '[B'

describe('InputBox —— / 命令菜单', () => {
  it('输入 / 弹出全部命令 + 提示行', async () => {
    const { stdin, lastFrame, unmount } = await mount()
    stdin.write('/')
    await tick()
    const out = lastFrame() ?? ''
    expect(out).toContain('/help')
    expect(out).toContain('/clear')
    expect(out).toContain('Tab/Enter 确认')
    unmount()
  })

  it('继续输入按子序列过滤候选', async () => {
    const { stdin, lastFrame, unmount } = await mount()
    stdin.write('/cl')
    await tick()
    const out = lastFrame() ?? ''
    expect(out).toContain('/clear')
    expect(out).not.toContain('/help') // 'cl' 不是 help 的子序列
    unmount()
  })

  it('选中无参命令（Enter）直接执行并清空输入', async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame, unmount } = await mount(onSubmit)
    stdin.write('/clear')
    await tick()
    stdin.write(ENTER)
    await tick()
    // 无参命令不带 displayText:acceptCommand 直接调 onSubmit(`/clear`),不走 handleSubmit
    expect(onSubmit).toHaveBeenCalledWith('/clear')
    // 执行后输入框清空：不再显示命令菜单。
    expect(lastFrame() ?? '').not.toContain('Tab/Enter 确认')
    unmount()
  })

  it('选中需参数命令（Tab）补全为「/名字 」且不执行', async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame, unmount } = await mount(onSubmit)
    stdin.write('/save')
    await tick()
    stdin.write(TAB)
    await tick()
    expect(onSubmit).not.toHaveBeenCalled()
    const out = lastFrame() ?? ''
    expect(out).toContain('/save') // 输入行补全为 /save␠
    expect(out).not.toContain('Tab/Enter 确认') // 有空格 → 菜单已隐藏
    unmount()
  })

  it('Esc 关闭菜单；Enter 不再被菜单截走', async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame, unmount } = await mount(onSubmit)
    stdin.write('/cl')
    await tick()
    stdin.write(ESC)
    await tick()
    expect(lastFrame() ?? '').not.toContain('Tab/Enter 确认') // 菜单已关
    stdin.write(ENTER)
    await tick()
    // 菜单关闭后回车走普通提交：文本 "/cl" trim 后非空 → 作为一条输入发送。
    // 纯文本提交 pastes 为空：displayText=undefined、pasteFiles=undefined
    expect(onSubmit).toHaveBeenCalledWith('/cl', undefined, undefined)
    unmount()
  })

  it('↓ 移动高亮后 Enter 选中的是高亮项', async () => {
    const onSubmit = vi.fn()
    const { stdin, unmount } = await mount(onSubmit)
    stdin.write('/')
    await tick()
    stdin.write(DOWN) // 从 help 移到 clear
    await tick()
    stdin.write(ENTER)
    await tick()
    // 无参命令 acceptCommand 直接调 onSubmit(`/${cmd.name}`),不带 displayText
    expect(onSubmit).toHaveBeenCalledWith('/clear')
    unmount()
  })

  it('移动高亮 → Esc → 改输入重开菜单后，高亮回到顶部', async () => {
    const onSubmit = vi.fn()
    const { stdin, unmount } = await mount(onSubmit)
    stdin.write('/')
    await tick()
    stdin.write(DOWN) // help → clear
    await tick()
    stdin.write(DOWN) // clear → config（高亮停在下标 2）
    await tick()
    stdin.write(ESC) // 关菜单
    await tick()
    stdin.write('c') // 输入变为 /c，菜单重开；候选 [clear, config]
    await tick()
    stdin.write(ENTER)
    await tick()
    // 高亮已随过滤词归零 → 选中的是首项 clear，而非残留下标指向的 config。
    // 无参命令 acceptCommand 直接调 onSubmit(`/${cmd.name}`),不带 displayText
    expect(onSubmit).toHaveBeenCalledWith('/clear')
    unmount()
  })

  it('Esc 关 → 提交 → 原样重打同串斜杠文本，菜单仍能重开', async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame, unmount } = await mount(onSubmit)
    stdin.write('/cl')
    await tick()
    stdin.write(ESC) // dismissedText 记为 "/cl"
    await tick()
    stdin.write(ENTER) // 普通提交，清空输入；dismissedText 应被一并清掉
    await tick()
    // 纯文本提交 pastes 为空：displayText=undefined、pasteFiles=undefined
    expect(onSubmit).toHaveBeenCalledWith('/cl', undefined, undefined)
    stdin.write('/cl') // 再次原样输入
    await tick()
    expect(lastFrame() ?? '').toContain('Tab/Enter 确认') // 菜单重新出现
    unmount()
  })
})

// bracketed paste 序列包装:用真实换行符构造多行粘贴。
function bracketedPaste(content: string): string {
  return `\x1b[200~${content}\x1b[201~`
}

describe('InputBox —— 粘贴折叠', () => {
  it('多行粘贴显示折叠标签、不铺全文', async () => {
    const { stdin, lastFrame, unmount } = await mount()
    // 发送多行 bracketed paste
    stdin.emit('data', bracketedPaste('第一行\n第二行'))
    await tick()
    const out = lastFrame() ?? ''
    // 应出现折叠标签
    expect(out).toContain('[粘贴#1')
    // 不应展示原始换行内容
    expect(out).not.toContain('第二行')
    unmount()
  })

  it('多行粘贴后提交:onSubmit 第一参含展开全文、第二参含折叠标签', async () => {
    // 显式标注函数类型,使 mock.calls 类型可解构
    const onSubmit = vi.fn<(text: string, displayText?: string, pasteFiles?: Record<number, string>) => void>()
    const { stdin, unmount } = await mount(onSubmit)
    stdin.emit('data', bracketedPaste('第一行\n第二行'))
    await tick()
    stdin.emit('data', ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledOnce()
    const args = onSubmit.mock.calls[0]!
    const full = args[0]
    const display = args[1]
    // 第一参是展开全文
    expect(full).toContain('第一行')
    expect(full).toContain('第二行')
    // 第二参是折叠展示串(含标签)
    expect(display).toContain('[粘贴#1')
    unmount()
  })

  it('单行粘贴当普通文本插入,不折叠', async () => {
    const { stdin, lastFrame, unmount } = await mount()
    stdin.emit('data', bracketedPaste('单行内容'))
    await tick()
    const out = lastFrame() ?? ''
    // 单行粘贴内容直接显示
    expect(out).toContain('单行内容')
    // 不应出现折叠标签
    expect(out).not.toContain('[粘贴#1')
    unmount()
  })
})

// mock writeToolOutputFile：返回固定路径，避免真正落盘
vi.mock('../toolOutputFile.js', () => ({
  writeToolOutputFile: vi.fn((_name: string, _content: string) => `/tmp/zuse/${_name}-mock.txt`),
  osc8FileLink: vi.fn((path: string, label: string) => `${label}(${path})`),
}))

describe('InputBox —— 粘贴提交 pasteFiles 第三参', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('多行粘贴后提交：onSubmit 第三参含 id→路径映射', async () => {
    // 签名包含第三参 pasteFiles
    const onSubmit = vi.fn<(text: string, displayText?: string, pasteFiles?: Record<number, string>) => void>()
    const { stdin, unmount } = await mount(onSubmit)
    stdin.emit('data', bracketedPaste('第一行\n第二行'))
    await tick()
    stdin.emit('data', ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledOnce()
    const args = onSubmit.mock.calls[0]!
    const pasteFiles = args[2]
    // 第三参应为 Record<number, string>，id=1 对应路径
    expect(pasteFiles).toBeDefined()
    expect(typeof pasteFiles![1]).toBe('string')
    expect(pasteFiles![1]).toContain('paste')
    unmount()
  })

  it('纯文本（无粘贴）提交：onSubmit 第三参为 undefined', async () => {
    const onSubmit = vi.fn<(text: string, displayText?: string, pasteFiles?: Record<number, string>) => void>()
    const { stdin, unmount } = await mount(onSubmit)
    stdin.write('你好世界')
    await tick()
    stdin.emit('data', ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledOnce()
    const args = onSubmit.mock.calls[0]!
    // 纯文本：displayText 和 pasteFiles 均为 undefined
    expect(args[1]).toBeUndefined()
    expect(args[2]).toBeUndefined()
    unmount()
  })
})
