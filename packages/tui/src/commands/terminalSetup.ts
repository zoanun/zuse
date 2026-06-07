import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { win32 as pathWin32, posix as pathPosix, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser'

/**
 * /terminal-setup：仿 Claude Code 的同名命令，为内置编辑器的集成终端自动写入
 * 「Ctrl+Enter 发送 ESC+CR」的 keybinding。VSCode 系编辑器默认会吃掉集成终端里的 Ctrl+Enter，
 * 这条绑定把它在 GUI 层重映射成 sendSequence、原子地发出 ESC+CR；stock Ink 收到后剥掉 ESC 前缀
 * 剩裸 CR，被 inputKeymap 判为换行（见 inputKeymap.ts）。普通终端不依赖本命令——其 Ctrl+Enter
 * 本就发裸 LF，inputKeymap 直接当换行处理。
 * 纯逻辑（detectEditor / keybindingsPath / upsertNewlineBindings）单测覆盖；
 * installTerminalSetup 只是其上的一层文件 IO 编排。
 */
export type EditorKind = 'vscode' | 'cursor' | 'windsurf'

// 控制字符/反斜杠一律用 fromCharCode 拼装,避免源码里的转义在工具链各层被反复解释。
const ESC = String.fromCharCode(0x1b)
const CR = String.fromCharCode(0x0d)
const LF = String.fromCharCode(0x0a)
const BS = String.fromCharCode(0x5c)

/** keybinding 真正发送的序列：ESC + CR。 */
const NEWLINE_SEQUENCE = ESC + CR

interface VSCodeKeybinding {
  key: string
  command: string
  args: { text: string }
  when: string
}

/**
 * 要写入的换行键：只装 Ctrl+Enter。VSCode 系编辑器默认会吃掉集成终端里的 Ctrl+Enter，
 * 这条绑定把它改成发 ESC+CR，被 inputKeymap 判为换行。只留一个键足够好用，不再绑 Shift+Enter
 * （它在普通终端与 Enter 同字节、本就分不开，多绑一个只是徒增覆盖面）。
 */
const NEWLINE_KEYS = ['ctrl+enter'] as const

/** 按 key 造一条「发送 ESC+CR」的 keybinding。 */
function bindingFor(key: string): VSCodeKeybinding {
  return {
    key,
    command: 'workbench.action.terminal.sendSequence',
    args: { text: NEWLINE_SEQUENCE },
    when: 'terminalFocus',
  }
}

/** 各编辑器的用户配置目录名（VSCode 历史原因叫 Code）。 */
const EDITOR_DIR: Record<EditorKind, string> = { vscode: 'Code', cursor: 'Cursor', windsurf: 'Windsurf' }
export const EDITOR_LABEL: Record<EditorKind, string> = { vscode: 'VSCode', cursor: 'Cursor', windsurf: 'Windsurf' }

/**
 * 从环境变量识别当前所处的内置编辑器终端。识别不出（普通终端/Apple Terminal 等）返回 null。
 * Cursor/Windsurf 在 WSL 等场景下 TERM_PROGRAM 仍是 'vscode'，故先看更确定的 CURSOR_TRACE_ID
 * 与 git askpass 路径，再退回 TERM_PROGRAM。
 */
export function detectEditor(env: NodeJS.ProcessEnv): EditorKind | null {
  if (env.CURSOR_TRACE_ID) return 'cursor'
  const askpass = env.VSCODE_GIT_ASKPASS_MAIN ?? ''
  if (askpass.includes('cursor')) return 'cursor'
  if (askpass.includes('windsurf')) return 'windsurf'
  if (env.TERM_PROGRAM === 'vscode') return 'vscode'
  return null
}

/**
 * 算出 keybindings.json 的绝对路径。按目标平台显式选 win32/posix 的 join，
 * 这样跨平台行为确定、也便于单测（不受运行测试的宿主 OS 影响）。
 */
export function keybindingsPath(editor: EditorKind, platform: NodeJS.Platform, home: string): string {
  const dir = EDITOR_DIR[editor]
  if (platform === 'win32') {
    return pathWin32.join(home, 'AppData', 'Roaming', dir, 'User', 'keybindings.json')
  }
  const userDir =
    platform === 'darwin'
      ? pathPosix.join(home, 'Library', 'Application Support', dir, 'User')
      : pathPosix.join(home, '.config', dir, 'User')
  return pathPosix.join(userDir, 'keybindings.json')
}

/** 判断解析后的数组里是否已含指定 key 的等效绑定。 */
function hasBinding(parsed: unknown, key: string): boolean {
  if (!Array.isArray(parsed)) return false
  return parsed.some((b) => {
    if (!b || typeof b !== 'object') return false
    const rec = b as Record<string, unknown>
    return (
      rec.key === key &&
      rec.command === 'workbench.action.terminal.sendSequence' &&
      rec.when === 'terminalFocus'
    )
  })
}

/** 把单条绑定并入 keybindings.json 文本（保留注释/缩进）；返回新文本。 */
function appendBinding(content: string, key: string): string {
  const binding = bindingFor(key)
  // 空文件：直接建一个单元素数组。
  if (content.trim() === '') {
    return JSON.stringify([binding], null, 2) + LF
  }
  const parsed = parseJsonc(content)
  const arr = Array.isArray(parsed) ? parsed : []
  // isArrayInsertion 表示在数组里新增一项而非覆盖；空数组插到 [0]，否则追加到末尾。
  const edits = modify(content, [arr.length === 0 ? 0 : arr.length], binding, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
    isArrayInsertion: true,
  })
  if (!edits || edits.length === 0) {
    // 兜底：顶层不是数组等情况无法生成编辑 → 重建为干净数组（备份机制保底,不丢原文件）。
    return JSON.stringify([...arr, binding], null, 2) + LF
  }
  return applyEdits(content, edits)
}

/**
 * 把 Shift+Enter 与 Ctrl+Enter 两条换行绑定并入 keybindings.json 文本。
 * 逐条处理：已存在的跳过，缺失的追加；added 列出本次新增的 key（为空表示无需改动）。
 * 每条都在最新文本上重新解析+插入，故多条追加时下标不会错位。
 */
export function upsertNewlineBindings(content: string): { content: string; added: string[] } {
  let current = content
  const added: string[] = []
  for (const key of NEWLINE_KEYS) {
    const parsed = current.trim() === '' ? [] : parseJsonc(current)
    if (hasBinding(parsed, key)) continue
    current = appendBinding(current, key)
    added.push(key)
  }
  return { content: current, added }
}

/** 给用户手动配置时照抄的 JSON 片段（识别不出编辑器或写盘失败时附上）。 */
function manualHint(): string {
  const escLiteral = `${BS}u001b${BS}r` // 展示给用户粘贴的转义文本 \r
  const block = (key: string): string[] => [
    '  {',
    `    "key": "${key}",`,
    '    "command": "workbench.action.terminal.sendSequence",',
    `    "args": { "text": "${escLiteral}" },`,
    '    "when": "terminalFocus"',
    '  }',
  ]
  return [
    '可手动配置：命令面板运行 “Preferences: Open Keyboard Shortcuts (JSON)”，在数组中加入：',
    ...block('ctrl+enter'),
  ].join(LF)
}

export interface TerminalSetupResult {
  ok: boolean
  message: string
}

/**
 * 实际执行安装：识别编辑器 → 定位 keybindings.json → 读现有 → 并入绑定 → 备份后写回。
 * 这层是纯逻辑之上的文件 IO 编排，行为靠 dev 实跑验证（纯逻辑已单测）。
 */
export async function installTerminalSetup(deps: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
}): Promise<TerminalSetupResult> {
  const editor = detectEditor(deps.env)
  if (!editor) {
    return {
      ok: false,
      message: ['未识别到 VSCode/Cursor/Windsurf 的集成终端，无法自动配置。', manualHint()].join(LF),
    }
  }
  const path = keybindingsPath(editor, deps.platform, deps.home)
  try {
    await mkdir(dirname(path), { recursive: true })
    let existing = ''
    let fileExisted = false
    try {
      existing = await readFile(path, 'utf8')
      fileExisted = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    const { content, added } = upsertNewlineBindings(existing)
    if (added.length === 0) {
      return { ok: true, message: `已存在 Ctrl+Enter 绑定，无需改动：${LF}  ${path}` }
    }
    // 改动既有文件前先备份，文件名带随机后缀避免覆盖历史备份。
    if (fileExisted) {
      await copyFile(path, `${path}.${randomBytes(4).toString('hex')}.bak`)
    }
    await writeFile(path, content, 'utf8')
    return {
      ok: true,
      message: [
        `已为 ${EDITOR_LABEL[editor]} 安装 Ctrl+Enter 换行绑定：`,
        `  ${path}`,
        '重新加载窗口（或重启编辑器）后，在集成终端里 Ctrl+Enter 换行、Enter 发送。',
        '（普通终端无需配置：Ctrl+Enter 本就能换行。）',
      ].join(LF),
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, message: [`写入 keybindings.json 失败：${reason}`, manualHint()].join(LF) }
  }
}
