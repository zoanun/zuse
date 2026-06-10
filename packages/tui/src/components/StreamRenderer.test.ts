import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { StreamRenderer } from './StreamRenderer.js'
import type { UIMessage } from '../types.js'

function frame(partial: Partial<UIMessage>, cwd = '/work'): string {
  const message: UIMessage = {
    id: '1',
    role: 'assistant',
    text: '',
    isStreaming: false,
    ...partial,
  }
  const { lastFrame, unmount } = render(createElement(StreamRenderer, { message, cwd }))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

describe('StreamRenderer 助手双态', () => {
  it('定稿后把 Markdown 渲染成富文本(列表出现圆点)', () => {
    const out = frame({ text: '- item', isStreaming: false })
    expect(out).toContain('•')
  })
  it('流式期间按原始纯文本渲染(保留 "- item",不出圆点)', () => {
    const out = frame({ text: '- item', isStreaming: true })
    expect(out).toContain('- item')
    expect(out).not.toContain('•')
  })
})

describe('StreamRenderer 用户消息', () => {
  it('用 › 标记 + 底色高亮渲染,不再用定宽边框盒子(避免缩放变形)', () => {
    const out = frame({ role: 'user', text: 'hello' })
    expect(out).toContain('› hello')
    // 不应出现圆角边框字符（曾经的 borderStyle="round"）。
    expect(out).not.toContain('╭')
    expect(out).not.toContain('╰')
  })
  it('多行用户消息逐行渲染,续行缩进对齐', () => {
    const out = frame({ role: 'user', text: 'line1\nline2' })
    expect(out).toContain('› line1')
    expect(out).toContain('line2')
  })
})

describe('StreamRenderer 工具输出截断', () => {
  it('输出超行内上限时,展示截断标记与可点击的完整输出文件路径', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join('\n')
    const out = frame({
      role: 'tool',
      tool: {
        name: 'Bash',
        input: { command: 'ls' },
        status: 'done',
        output: lines,
        outputFile: '/tmp/zuse/bash-x.txt',
      },
    })
    expect(out).toContain('… +12 行')
    expect(out).toContain('/tmp/zuse/bash-x.txt')
    // 路径包成 OSC 8 超链接:帧里应含 file:// URI 的 OSC 8 引导序列。
    expect(out).toContain(']8;;file:')
    // 仅展示前 3 行:第 4 行不应出现。
    expect(out).not.toContain('line4')
  })
})

describe('StreamRenderer user 消息双份文本', () => {
  it('user 消息有 displayText 时渲染 displayText、不渲染 text', () => {
    const out = frame({
      role: 'user',
      text: '超长全文不该出现',
      displayText: '[粘贴#1 · 9 行 · 1.0k 字符]',
    })
    expect(out).toContain('[粘贴#1')
    expect(out).not.toContain('超长全文不该出现')
  })
  it('user 消息无 displayText 时回落到 text', () => {
    const out = frame({ role: 'user', text: '普通文本' })
    expect(out).toContain('普通文本')
  })
})

describe('StreamRenderer Glob/Grep 文件清单', () => {
  it('Glob 列出命中文件并包成可点击链接(Found N + OSC 8 file:// URI)', () => {
    const out = frame(
      {
        role: 'tool',
        tool: {
          name: 'Glob',
          input: { pattern: '**/*.ts' },
          status: 'done',
          output: 'src/a.ts\nsrc/b.ts',
        },
      },
      '/work',
    )
    expect(out).toContain('Found 2 files')
    expect(out).toContain('src/a.ts')
    // 每个文件包成 OSC 8 超链接,链接目标是 cwd 拼出的绝对路径 file:// URI。
    expect(out).toContain(']8;;file:')
  })

  it('命中超 3 个时只列前 3,余下显示「… +N 个」', () => {
    const out = frame({
      role: 'tool',
      tool: {
        name: 'Glob',
        input: { pattern: '**/*.ts' },
        status: 'done',
        output: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts',
      },
    })
    expect(out).toContain('Found 5 files')
    expect(out).toContain('… +2 个')
    expect(out).not.toContain('d.ts')
  })

  it('有落盘文件时「… +N 个」整行变成指向临时文件的链接', () => {
    const out = frame({
      role: 'tool',
      tool: {
        name: 'Glob',
        input: { pattern: '**/*.ts' },
        status: 'done',
        output: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts',
        outputFile: '/tmp/zuse/glob-x.txt',
      },
    })
    expect(out).toContain('… +2 个(点击查看全部)')
    // 该行包成指向临时文件的 OSC 8 链接。
    expect(out).toContain('glob-x.txt')
    expect(out).toContain(']8;;file:')
  })

  it('Grep files 模式同样列出可点击文件', () => {
    const out = frame({
      role: 'tool',
      tool: {
        name: 'Grep',
        input: { pattern: 'foo' },
        status: 'done',
        output: 'lib/x.ts\nlib/y.ts',
      },
    })
    expect(out).toContain('Found 2 files')
    expect(out).toContain(']8;;file:')
  })

  it('单个命中显示「Found 1 file」(单数)', () => {
    const out = frame({
      role: 'tool',
      tool: { name: 'Glob', input: { pattern: '**/*.ts' }, status: 'done', output: 'only.ts' },
    })
    expect(out).toContain('Found 1 file')
    expect(out).not.toContain('Found 1 files') // 守住单复数边界
  })

  it('Glob input.cwd 把链接基准目录改为 cwd/sub(链接目标含 sub 段)', () => {
    const out = frame({
      role: 'tool',
      tool: { name: 'Glob', input: { pattern: '**/*.ts', cwd: 'sub' }, status: 'done', output: 'a.ts' },
    }, '/work')
    // 链接目标 = resolve(cwd, 'sub', 'a.ts);file:// URI 用正斜杠,应含 sub/a.ts 段。
    // (不写死整段绝对路径:Windows 会拼出盘符,只断言相对子段跨平台稳定。)
    expect(out).toContain('sub/a.ts')
  })

  it('工具记录的 cwd 优先于入口 cwd(Bash cd 后链接仍指向真实目录)', () => {
    // tool.cwd 模拟 cd 到 /work/deep 之后运行的 Glob:链接基准应是 /work/deep 而非入口 /work。
    const out = frame({
      role: 'tool',
      tool: { name: 'Glob', input: { pattern: '*.ts' }, status: 'done', output: 'a.ts', cwd: '/work/deep' },
    }, '/work')
    expect(out).toContain('deep/a.ts')
  })
})
