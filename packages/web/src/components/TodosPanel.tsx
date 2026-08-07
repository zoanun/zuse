import type { TodoItemLite } from '@zuse/protocol'
import { taskMarker, type TaskStatus } from './taskMarker.js'

// TodoWrite status → shared marker/row status (same set the chat markdown task-lists use).
const STATUS_CLS: Record<TodoItemLite['status'], TaskStatus> = {
  completed: 'done',
  in_progress: 'doing',
  pending: 'todo',
}

/**
 * 待办面板可见吗（设计 §8）。
 *
 * 这个判据以前只长在组件内部（`!todos.length` + 「全完成也消失」两条）。右栏要按
 * 「有没有内容」决定显不显示，**必须复用这一个函数、不许在 Shell 里再写一份** ——
 * 复刻出来的第二份判据一定会随时间漂移，届时右栏会出现「空壳占位」或「有待办却不开栏」。
 * 组件自己也走它（见下），这样两边不可能不一致。
 *
 * 语义：一条都没有 → 不可见；全部 completed → 不可见（计划做完了就该清场）。
 */
export function hasVisibleTodos(todos: readonly TodoItemLite[]): boolean {
  return todos.some((t) => t.status !== 'completed')
}

export function TodosPanel({ todos }: { todos: TodoItemLite[] }) {
  if (!hasVisibleTodos(todos)) return null
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todos">
      <div className="th"><span>任务</span><span>{done} / {todos.length}</span></div>
      {todos.map((t, i) => {
        const cls = STATUS_CLS[t.status] ?? 'todo'
        return <div key={i} className={'ti ' + cls}>{taskMarker(cls)}<span>{t.content}</span></div>
      })}
    </div>
  )
}
