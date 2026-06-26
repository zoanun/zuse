import type { TodoItemLite } from '@zuse/protocol'

// status → row/marker class. The marker (.cbx) is drawn in CSS and shared with the
// chat markdown task-lists so both render identically: empty box / blue square+dot /
// green check.
const STATUS_CLS: Record<TodoItemLite['status'], string> = {
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
        const marker = cls === 'doing'
          ? <span className="cbx doing" aria-hidden="true" />
          : <input type="checkbox" className="cbx-native" defaultChecked={cls === 'done'} disabled aria-hidden="true" />
        return <div key={i} className={'ti ' + cls}>{marker}<span>{t.content}</span></div>
      })}
    </div>
  )
}
