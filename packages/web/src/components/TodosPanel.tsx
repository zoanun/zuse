import type { TodoItemLite } from '@zuse/protocol'

// status → { row class, glyph }; keeps cls/icon in lockstep (one place to edit).
const STATUS: Record<TodoItemLite['status'], { cls: string; icon: string }> = {
  completed: { cls: 'done', icon: '✓' },
  in_progress: { cls: 'doing', icon: '●' },
  pending: { cls: 'todo', icon: '○' },
}

export function TodosPanel({ todos }: { todos: TodoItemLite[] }) {
  if (!todos.length) return null
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todos">
      <div className="th"><span>Tasks</span><span>{done} / {todos.length}</span></div>
      {todos.map((t, i) => {
        const { cls, icon } = STATUS[t.status] ?? STATUS.pending
        return <div key={i} className={'ti ' + cls}><span className="ic">{icon}</span><span>{t.content}</span></div>
      })}
    </div>
  )
}
