/**
 * `/` 命令选择菜单的纯逻辑核心：判定菜单是否激活、取过滤词、筛选并排序候选。
 * 抽成不依赖 React/ink 的纯函数，既能单测，也让 InputBox 壳保持轻薄
 *（与 selectListCore.ts、registry.ts 把可测逻辑抽出来同一套路）。
 * 命名带 Core 后缀以区别于呈现组件 CommandMenu.tsx —— 否则在大小写不敏感的文件系统
 *（如 Windows）上，`./commandMenu.js` 与 `./CommandMenu.js` 会解析到同一模块、导入错配。
 */
import type { CommandInfo } from '../commands/types.js'
import { matchesFilter } from './selectListCore.js'

export type { CommandInfo } from '../commands/types.js'

/**
 * 菜单是否激活：输入以 `/` 开头且尚未出现空白（还在敲命令名）。一旦打了空格（进入参数输入），
 * 菜单消失、按键还给输入框。空 `/` 也算激活（展示全部命令）。
 * 仅识别「整段输入就是一个斜杠命令 token」的起始场景，不处理输入中段的 `/`（YAGNI）。
 */
export function isCommandMenuActive(text: string): boolean {
  return /^\/\S*$/.test(text)
}

/** `/` 之后的过滤词（命令名片段）；非菜单输入返回空串。 */
export function commandMenuQuery(text: string): string {
  if (!isCommandMenuActive(text)) return ''
  return text.slice(1)
}

/**
 * 按过滤词筛选并排序命令候选。
 * 匹配：子序列模糊（复用 matchesFilter），命中命令名或描述其一即保留。
 * 排序：精确名 > 前缀名 > 其它；同档按原下标稳定，保持命令表里的声明顺序。
 * 空词返回全部（原序）。
 */
export function filterCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase()
  if (q === '') return commands
  const matched = commands.filter((c) => matchesFilter(c.name, q) || matchesFilter(c.description, q))
  const rank = (c: CommandInfo): number => {
    const name = c.name.toLowerCase()
    if (name === q) return 0
    if (name.startsWith(q)) return 1
    return 2
  }
  // 显式带原下标排序，避免依赖引擎 sort 是否稳定，确保同档保持声明顺序。
  return matched
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c)
}

/** 环绕取下一个高亮下标：到顶再上回末尾、到底再下回开头。len<=0 时返回 0。 */
export function wrapIndex(index: number, len: number): number {
  if (len <= 0) return 0
  return ((index % len) + len) % len
}
