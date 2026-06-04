# Zuse

A self-built coding agent CLI. Learning project + daily-use tool.

See [design spec](docs/superpowers/specs/2026-05-21-zuse-design.md) for goals and roadmap.

## Status

Phase 4: Done. Full v1 toolset. `Write` (whole-file, creates parent dirs),
`Edit` (exact-string replace, `replace_all`), `LS`, `Glob` (Node 22 built-in
`fs.glob`, zero deps), `Grep` (hand-rolled enumerate + per-line regex, no
ripgrep dep), and `Bash` (spawn via shell with cwd, timeout, output truncation,
abort-signal kill, cross-platform process-tree kill). The headline is
**read-before-edit**: `Edit` refuses to touch a file that hasn't been `Read`,
and refuses if the file's mtime changed since it was read (optimistic lock
against TOCTOU). Read state lives in a session `FileReadTracker` carried on
`ToolContext`. Next: Phase 5 — permissions.

Phase 3: Done. The agent can now use tools. A `Tool` interface + `ToolRegistry`
in core, the Agent loop (`runAgent`: ask model → run requested tools → feed
results back → repeat, capped at 50 turns), and the first tool — `Read` (cat -n
style output, offset/limit). Tool calls and their results render inline in the
transcript. Tool errors (unknown tool, thrown error) are fed back to the model as
`is_error` results instead of crashing the turn.

Phase 2: Done. Multi-turn conversation with full context re-send each turn, a
running token total, and the live context size in the footer (yellow past 100k).
Slash commands: `/help`, `/clear`, `/save <name>`, `/load <name>` (sessions stored
under `~/.zuse/sessions`).
