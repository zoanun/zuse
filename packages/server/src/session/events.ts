/**
 * 线缆 DTO（SessionEvent / SessionSnapshot / TodoItemLite / PendingPermissionLite）
 * 已迁到 @zuse/protocol 作为 web↔server 的唯一契约；这里转手 re-export，保持
 * 既有 import 路径（SessionManager / index.ts 仍从 './events.js' 取）不变。
 *
 * SnapshotStore / SessionCheckpoint 是 SessionManager 的内部契约（非线缆类型），
 * 留在 server 本地。
 */
export type {
  SessionEvent,
  SessionSnapshot,
  TodoItemLite,
  PendingPermissionLite,
} from '@zuse/protocol'

/**
 * Shadow-git snapshot backend used for checkpoint/revert (Phase 12). Narrow seam:
 * the SessionManager only needs to track() a checkpoint and restore() to one.
 */
export interface SnapshotStore {
  /** Snapshot the workspace before a turn; resolves to a commit-hash anchor, or null on no-op/failure. */
  track(): Promise<string | null>
  /** Restore the workspace to a previously-tracked hash. Rejects on failure. */
  restore(hash: string): Promise<void>
}

/**
 * A session checkpoint (Phase 12): a shadow-git snapshot anchor captured before a
 * user turn. /revert = restore(hash) + truncate the ledger to messageIndex.
 * Mirrors the TUI's SessionCheckpoint shape but defined server-local — the TUI
 * copy lives in @zuse/tui and must not be imported here (decoupling boundary).
 */
export interface SessionCheckpoint {
  /** Index of this turn's user message in the ledger (revert truncates to here). */
  messageIndex: number
  /** Shadow-git commit hash; the checkpoint-recorded event uses this as `id`. */
  hash: string
  /** ISO timestamp when the snapshot was taken. */
  at: string
  /** First ~80 chars of the user's message, for display. */
  label: string
  /**
   * Id of the user message this checkpoint anchors before. Optional so legacy persisted
   * checkpoints (recorded before this field existed) still deserialize; revert/retry fall
   * back to messageIndex when it's absent.
   */
  anchorMessageId?: string
}
