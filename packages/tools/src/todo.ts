import type { Tool } from '@zuse/core'
// 排序住在 protocol：回显（给模型看）与右栏面板（给用户看）必须同一套，见该函数注释。
import { groupTodos } from '@zuse/protocol'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** 组名上限。右栏标题只有一行，更长的要么折行要么撑破布局；组名本就该是短标签。 */
const GROUP_NAME_CAP = 60

export interface TodoItem {
  content: string
  status: TodoStatus
  /**
   * 可选分组名。缺省 = 不分组（与加这个字段之前完全一致）。
   *
   * 加它的理由不是排版，是**正确性**：此前模型只能把组名塞进 content 当前缀，
   * 于是每次「把第 N 组都改成 X」它都要重新解析自己发明的前缀去定位子列表 ——
   * 而它解析错过（用户原话：「你怎么能判断成是项目A呢？？？？」）。
   */
  group?: string
}

export interface TodoWriteDeps {
  onUpdate: (todos: TodoItem[]) => void
}

export function createTodoWriteTool(deps: TodoWriteDeps): Tool {
  return {
    name: 'TodoWrite',
    // 会话级：onUpdate 绑的是**父会话**的 setTodos —— 子代理继承它就会整份顶掉用户正在看的
    // 那份待办（整份覆盖语义），用户分的几组当场消失。见 Tool.sessionScoped。
    sessionScoped: true,
    description:
      'Create and manage a structured task list. Pass the full updated list each time. ' +
      'Use to track progress on multi-step tasks. Mark tasks in_progress before starting, ' +
      // 「每组至多一条」而不是「全局至多一条」：分了组本身就意味着同时推进几摊活，
      // 全局单条等于禁止并行推进，直接违背分组的初衷。未分组时两种说法等价。
      'completed when done. At most one task per group should be in_progress at a time. ' +
      'Write task content in the same language the user uses.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Task description' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Task status',
              },
              group: {
                type: 'string',
                description:
                  'Optional list name. Set it when the user asks for several SEPARATE lists ' +
                  '(e.g. "make me 3 todo lists"): give every task of the same list the same ' +
                  'group string, e.g. group:"Project A" / group:"Errands". Do NOT put the list ' +
                  'name in `content` — that is what this field is for. Omit it entirely for an ' +
                  'ordinary single list. Keep the string identical across calls so the list ' +
                  'does not split in two.',
              },
            },
            required: ['content', 'status'],
          },
          description: 'Full task list (replaces the entire list on each call)',
        },
      },
      required: ['todos'],
    },
    async run(input: unknown) {
      const { todos } = input as { todos?: unknown }

      if (!Array.isArray(todos)) {
        return { output: 'TodoWrite requires a "todos" array.', isError: true }
      }

      const validated: TodoItem[] = []
      for (const item of todos) {
        const { content, status, group } = (item ?? {}) as { content?: unknown; status?: unknown; group?: unknown }
        if (typeof content !== 'string' || content === '') continue
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
        // 先 trim 再判空：模型给出 '   ' 这种应当视为「没填」，而不是造出一个空名分组。
        // 不做模糊归并（大小写折叠、全半角归一）—— 那是猜，猜错了两个真正不同的组会被
        // 合并，比裂开更难发现。近似组名（「项目A」/「项目 A」）会裂，这是已知代价。
        const g = typeof group === 'string' ? group.trim() : ''
        validated.push(g === '' ? { content, status } : { content, status, group: g.slice(0, GROUP_NAME_CAP) })
      }

      deps.onUpdate(validated)

      const icons: Record<TodoStatus, string> = { completed: '✓', in_progress: '●', pending: '○' }
      // 回显必须带分组。TodoWrite 是**整份覆盖**：模型每一轮都从这串文本重建整张表 ——
      // 这是它最新、最显眼的记录。这里丢掉 group，下一次调用就会退回平表，整个功能白做。
      // （同理见 SessionManager 的压缩提示词：那条路每几十轮才走一次，这条路每次都走。）
      // 全部无分组时输出与加这个字段之前**逐字节相同**，不出现任何空标题。
      const lines: string[] = []
      for (const { group, items } of groupTodos(validated)) {
        if (group !== undefined) lines.push(`[${group}]`)
        for (const t of items) lines.push(`${icons[t.status]} ${t.content}`)
      }
      const counts = {
        completed: validated.filter((t) => t.status === 'completed').length,
        total: validated.length,
      }

      return {
        output: `${lines.join('\n')}\n(${counts.completed}/${counts.total} completed)`,
      }
    },
  }
}
