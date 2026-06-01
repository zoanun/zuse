# Zuse

A self-built coding agent CLI. Learning project + daily-use tool.

See [design spec](docs/superpowers/specs/2026-05-21-zuse-design.md) for goals and roadmap.

## Status

Phase 2: Done. Multi-turn conversation with full context re-send each turn, a
running token total, and the live context size in the footer (yellow past 100k).
Slash commands: `/help`, `/clear`, `/save <name>`, `/load <name>` (sessions stored
under `~/.zuse/sessions`). Next: Phase 3 — tools.
