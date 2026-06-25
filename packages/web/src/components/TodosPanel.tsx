import type { TodoItemLite } from '@zuse/protocol'

export function TodosPanel({ todos }: { todos: TodoItemLite[] }) {
  if (!todos.length) return null
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todos">
      <div className="th"><span>Tasks</span><span>{done} / {todos.length}</span></div>
      {todos.map((t, i) => {
        const cls = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : 'todo'
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'
        return <div key={i} className={'ti ' + cls}><span className="ic">{icon}</span><span>{t.content}</span></div>
      })}
    </div>
  )
}
