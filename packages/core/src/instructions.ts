/**
 * 常驻指令文件加载(Phase 13A)——把用户/项目级指令与记忆索引拼进系统提示词。
 *
 * 三类来源(注入顺序 = 列表顺序):
 *   1. `~/.zuse/SYSTEM.md`  用户全局指令(语言偏好、工作习惯),所有项目生效;
 *   2. `ZUSE.md`            项目指令,从 cwd 向上逐级收集到根,外层在前内层在后
 *                           (内层更具体、后出现权重更高;monorepo 仓库根与包级都生效);
 *   3. `~/.zuse/MEMORY.md`  记忆索引(memory.db 的投影,见 Phase 13D),排最后。
 *
 * 只在会话启动时读一次(D5):系统提示词稳定才有 prompt cache 命中,会话中途
 * 改文件不热加载。每个文件按行边界截断(窗口护栏,故障模式②)。
 * 设计见 docs/superpowers/specs/2026-06-12-zuse-project-memory-design.md。
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

/** 系统提示词的一个附加段(标头注明来源,模型知道指令来自哪一层)。 */
export interface PromptSection {
  title: string
  content: string
}

/** 单个指令文件的截断上限(字符)。 */
export const INSTRUCTION_FILE_CAP = 20_000

/** 记忆索引(MEMORY.md)的截断上限:它是索引不是正文,给更小预算。 */
export const MEMORY_INDEX_CAP = 8_000

/** 读文件;不存在/不可读返回 null(指令文件全部可选,缺失不是错误)。 */
function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 行边界截断:超限时回退到上一个完整行,并附截断标记。 */
function capAtLineBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text
  const head = text.slice(0, cap)
  const lastNewline = head.lastIndexOf('\n')
  const kept = lastNewline > 0 ? head.slice(0, lastNewline) : head
  return `${kept}\n[truncated: file is ${text.length} chars; showing first ${kept.length}]`
}

/** 读取 + 清洗成 section;空白文件不产出。 */
function fileSection(path: string, title: string, cap: number): PromptSection | null {
  const raw = tryRead(path)
  if (raw === null) return null
  const content = capAtLineBoundary(raw.trim(), cap)
  if (!content) return null
  return { title, content }
}

/** 从 cwd 向上到根的目录链,外层(根)在前。 */
function ancestorChain(cwd: string): string[] {
  const chain: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    chain.unshift(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return chain
}

/**
 * 加载全部提示词附加段。home/cwd 显式传参(测试注入临时目录),
 * 调用方传 os.homedir() 与会话 cwd。
 */
export function loadPromptSections(home: string, cwd: string): PromptSection[] {
  const sections: PromptSection[] = []

  const system = fileSection(
    join(home, '.zuse', 'SYSTEM.md'),
    'User instructions (~/.zuse/SYSTEM.md)',
    INSTRUCTION_FILE_CAP,
  )
  if (system) sections.push(system)

  for (const dir of ancestorChain(cwd)) {
    const s = fileSection(join(dir, 'ZUSE.md'), `Project instructions (${join(dir, 'ZUSE.md')})`, INSTRUCTION_FILE_CAP)
    if (s) sections.push(s)
  }

  const memory = fileSection(
    join(home, '.zuse', 'MEMORY.md'),
    'Memory index (~/.zuse/MEMORY.md) — saved memories; use the Memory tool to search details or save new ones',
    MEMORY_INDEX_CAP,
  )
  if (memory) sections.push(memory)

  return sections
}
