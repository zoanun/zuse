import type { ReactNode } from 'react'

export type TaskStatus = 'done' | 'doing' | 'todo'

/**
 * The visual marker for a task status, shared by chat markdown task-lists and the
 * Tasks panel so both render identically: a re-tinted default checkbox for done/todo
 * (no custom checkmark — just accent-color), and a solid square for in-progress.
 */
export function taskMarker(status: TaskStatus): ReactNode {
  if (status === 'doing') return <span className="cbx doing" aria-hidden="true" />
  return <input type="checkbox" className="cbx-native" defaultChecked={status === 'done'} disabled aria-hidden="true" />
}
