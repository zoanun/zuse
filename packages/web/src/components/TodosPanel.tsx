import type { TodoItemLite } from '@zuse/protocol'
import { taskMarker, type TaskStatus } from './taskMarker.js'

// TodoWrite status → shared marker/row status (same set the chat markdown task-lists use).
const STATUS_CLS: Record<TodoItemLite['status'], TaskStatus> = {
  completed: 'done',
  in_progress: 'doing',
  pending: 'todo',
}

export function TodosPanel({ todos }: { todos: TodoItemLite[] }) {
  if (!todos.length) return null
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todos">
      <div className="th"><span>Tasks</span><span>{done} / {todos.length}</span></div>
      {todos.map((t, i) => {
        const cls = STATUS_CLS[t.status] ?? 'todo'
        return <div key={i} className={'ti ' + cls}>{taskMarker(cls)}<span>{t.content}</span></div>
      })}
    </div>
  )
}
