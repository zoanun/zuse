# Zuse

A self-built coding agent CLI. Learning project + daily-use tool.

See [design spec](docs/superpowers/specs/2026-05-21-zuse-design.md) for goals and roadmap.

## Status

Phase 3: Done. The agent can now use tools. A `Tool` interface + `ToolRegistry`
in core, the Agent loop (`runAgent`: ask model → run requested tools → feed
results back → repeat, capped at 50 turns), and the first tool — `Read` (cat -n
style output, offset/limit). Tool calls and their results render inline in the
transcript. Tool errors (unknown tool, thrown error) are fed back to the model as
`is_error` results instead of crashing the turn. Next: Phase 4 — Write, Edit,
Bash, Glob, Grep.

Phase 2: Done. Multi-turn conversation with full context re-send each turn, a
running token total, and the live context size in the footer (yellow past 100k).
Slash commands: `/help`, `/clear`, `/save <name>`, `/load <name>` (sessions stored
under `~/.zuse/sessions`).
