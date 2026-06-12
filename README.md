# Zuse

A self-built coding agent CLI. Learning project + daily-use tool.

See [design spec](docs/superpowers/specs/2026-05-21-zuse-design.md) for goals and roadmap.

## Status

Phase 10: Done. 会话管理与上下文压缩。自动会话按 cwd 分组存
`~/.zuse/sessions/auto/`,每回合自动保存;`zuse --continue` 续接最新会话,
`--resume <序号>` 指定续接,会话内 `/resume` 列表续接,`/clear` 换新会话不覆写旧
历史。压缩:`/compact` 手动 / 占用越过 provider `contextWindow`(缺省 128k)的 80%
自动——老回合折叠为结构化摘要,保留最近 2 个真实回合,切点永不劈开 tool_use/
tool_result 配对;摘要失败绝不半压。下一步:Phase 11 鲁棒性与恢复。

Phase 9: Done. 输出整形(Feedback Shaping)。可寻址输出(Read/Grep/Glob)维持分页+
续读指引;不可寻址 blob 归一到 `truncate.ts`:head+tail 行边界截断、统一
`[truncated: …]` marker。Bash 从「30k 触顶丢尾」(报错堆栈恰在尾部)改为 head 10k +
tail 20k,截断时完整输出落盘 `~/.zuse/tool-output/`,模型用 Read/Grep 续查;流式塑形
内存恒有界。WebFetch 共享同一模块只留头。下一步:Phase 10 会话管理与上下文压缩。

Phase 8: Done. 错误回传契约(Observation Contract)。工具交还给模型的一切都是写给
模型读的 observation:失败不抛裸异常、不回 stack trace,带具体入参回显与**下一步
指令**(重读文件 / 换工具 / 改入参 / 别再重试)。本期收口:Unknown tool 列可用工具
清单;权限拒绝分两档语义(settings deny=硬护栏别重试,user deny=问用户意图);Read
文件不存在指引 Glob、二进制拒读;Edit old_string 未命中指引重读;Bash 超时/127 点破
原因。下一步:Phase 9 输出整形 / Phase 10 上下文压缩。

Phase 6: Done. 多 provider。`ModelClient` 接口下两套手搓实现——`AnthropicClient`
（Anthropic 原生 + DashScope 等兼容端点，含 prompt 缓存 cache_control 三断点）与
`OpenAIClient`（OpenAI 协议：DeepSeek / 本地 Ollama / vLLM，手写 tool_call 分片累积
与 usage 抽取）。数据驱动的 `providers` registry：加 provider = 一条配置 + 一个
env var。`/model` 运行时切换（session 生效，`--save` 写盘），切换不清空历史。footer
显示缓存命中。下一步：Phase 6.5 联网工具 / Phase 7 UI 打磨。

Phase 5: Done. 三层配置系统（用户层 / 项目层 / 本地层），权限模型（`Tool(specifier)`
规则文法 + `decide()` 四档裁决），`ask` 交互式批准弹框，工具暴露开关。deny 是硬护栏，
压过 bypassPermissions。

Phase 4: Done. Full v1 toolset. `Write` (whole-file, creates parent dirs),
`Edit` (exact-string replace, `replace_all`), `Glob` (readdir walk +
`path.matchesGlob`, includes dotfiles, sorted by mtime), `Grep` (ripgrep via
`@vscode/ripgrep`, respects `.gitignore`), and `Bash` (spawn via shell with cwd,
timeout, output truncation, abort-signal kill, cross-platform process-tree
kill). No standalone `LS` tool — like Claude Code, directory listing goes
through `Bash(ls)`. The headline is
**read-before-edit**: `Edit` refuses to touch a file that hasn't been `Read`,
and refuses if the file's mtime changed since it was read (optimistic lock
against TOCTOU). Read state lives in a session `FileReadTracker` carried on
`ToolContext`. Next: Phase 5 — permissions (done); Phase 6 — multi-provider (done).

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
