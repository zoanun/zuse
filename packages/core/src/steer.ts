/**
 * Mid-turn steer: a message the user sends while a reply is still streaming. The LLM API forbids a
 * standalone user message between a tool_use and its tool_result, so a steer sent during a tool
 * batch is FOLDED into the last tool_result's content (see agent.ts) — this builds that block.
 *
 * Crucially, the fold is ALSO recorded structurally on the carrier message (Message.steer), so the
 * snapshot projector identifies the steer by that field, never by parsing this text out of content
 * again (which would collide with real content — e.g. a tool that reads this very file).
 */
const STEER_OPEN = '[USER MESSAGE — sent while you were working]'
const STEER_CLOSE = '[/USER MESSAGE]'
const STEER_INSTRUCTION =
  "IMPORTANT: Address the user's message above. It takes priority over your current task. " +
  'You may continue your current work after acknowledging it, or change direction if they asked you to.'

/**
 * The separator + model-facing injection block, appended to an existing tool_result's output when a
 * steer is folded in (agent.ts). Deterministic from `text`, so the snapshot projector reconstructs
 * this exact substring to strip it back out for display (SessionManager.projectMessages).
 */
export function steerFoldSuffix(text: string): string {
  return `\n\n${STEER_OPEN}\n${text}\n${STEER_CLOSE}\n${STEER_INSTRUCTION}`
}
