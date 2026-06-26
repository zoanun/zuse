# 全仓 /simplify 扫描计划(窄切片、全覆盖)

> **日期**: 2026-06-26
> **目标**: 用 `/simplify` 的 4 角度(复用 / 简化 / 效率 / 高度)审查**整个 monorepo 源码**(~21k 行 / 6 包),但**不**一个大包一坨地审——把范围切成 ~23 个**窄切片**,每片一个内聚子系统(~600–1200 行),小到能审深;所有切片拼起来覆盖全部源码。
> **方法**: 每片 = 并行 4 个审查代理(各一角度,只读不改)→ 去重 → 我按质量栏逐条应用修复(会改行为/超出片范围/误报的跳过并说明)→ 该片小结 → 进下一片。**片是停点**,可随时叫停/调序。
> **不审**: `*.test.*`、`dist`、生成物;`packages/server/src/http/devPage.ts`(655 行一次性 dev HTML 字符串,即将被真 SPA 取代,无审价值)。

## 进度
- [x] **protocol**(纯 type-only):无可清理。
- [x] **web**(单片):已审 + 已应用(memo Message/插件 hoist/TodosPanel 查表/partsText)。
- [x] **core/tools/tui/server 22 片**:审查扇出完成(workflow `wf_b5884e81-40d`,22 代理、83 条发现,全量在 `tasks/wfrtbtqc3.output`)。

## 扫描结果(2026-06-26)
83 条发现,绝大多数是**稳定旧码上**的低severity小项 / 跨包"抽公共 util" / 行为敏感处。按 `/simplify` 质量栏(改质量、不改行为、不为清理而冒险),**应用了高置信安全子集**,其余 triaged-deferred。

**已应用(commit 232c869,core+server;web 在 b973e1a):**
- core compaction `messageChars()` 去重(2 处逐字重复,high)
- core settings 三处 dedupe 循环化;hooks `HOOK_TIMEOUT_MS` 常量;openai-client 类型谓词 filter + `map(b=>b.text)`
- server `steer()` 去重 trim
- web:`React.memo(Message)`+稳定 onRevert(热路径)、Markdown 插件 hoist、TodosPanel 查表、partsText 抽取

**deferred(不应用,理由分类):**
- **行为敏感 / 关键路径**(改了可能微妙改变行为,stable 码不冒险):agent.ts 每回合 `[...base,...staged]` spread(O(N²),需重构热路径)、bash-security extractQuotedContent 冗余判断(安全相关)、parseKeypress ParsedKey 工厂、hooks 选择性 env(hook 可能依赖全 env)、read.ts 用 clampPositiveInt(改校验语义)、tui clampIndex 复用(无单测、夹取语义)。
- **跨包/新模块抽取**(churn 大、引入跨包耦合,收益边际):`ensureError`/`toErrorMessage`(9 处 err 转换)、web fetch-seam、`capAtLineBoundary`(core↔tools)、时间戳格式 util、`flattenWhitespace`/`capLine`。
- **精细文件**:workflow.ts(resume 日志 + 已知 tsc 债)的 mkdirSync/模型解析。
- **微优化/nitpick**:todo 计数、commandMenu rank 预算、SessionManager checkpoint Map 索引(checkpoints 通常很小)、各种"魔数→常量"。
- 这些全部留作可选 follow-up,需要时按文件单独处理。

> 注:`workflow.test.ts` 仍有 4 处预存 tsc 类型错(`c9d6192` 带入,vitest 通过、仅 typecheck 报),与本轮无关,另修。

## 切片清单

### core(4858 行 → 6 片)
| 片 | 文件 | ~行 |
|----|------|-----|
| C1 模型客户端/流 | model-client, anthropic-client, openai-client, stream-idle, retry | 875 |
| C2 对话/压缩/标题 | conversation, compaction, title, memory-consolidation | 645 |
| C3 agent+工具+权限 | agent, tool, permission, bash-security | 1249 |
| C4 配置/类型/提示 | settings, types, prompt, instructions, proxy, hooks, failoverCore, debug-log, index | 1064 |
| C5 MCP | mcp-transport, mcp-registry, mcp-client | 737 |
| C6 workflow | workflow（注:已知 4 处 tsc 类型债，一并记） | 288 |

### tools(5571 行 → 6 片)
| 片 | 文件 | ~行 |
|----|------|-----|
| T1 文件操作 | read, write, edit, glob, grep, truncate | 1066 |
| T2 shell/隔离 | bash, shell-snapshot, tmux-isolation, worktree | 949 |
| T3 记忆/情节 | memory, memory-store, episode-store | 854 |
| T4 联网 | websearch, webfetch | 609 |
| T5 agent工具/技能/快照 | agent-tool, skills, todo, schedule-wakeup, snapshot, util, index | 860 |
| T6 LSP | lsp/*(client, index, format, install, servers, manager, seed, symbol, warmup) | 1221 |

### tui(6759 行 → 7 片)
| 片 | 文件 | ~行 |
|----|------|-----|
| U1 会话 hook | hooks/useConversation | 1116 |
| U2 键盘解析 | input/parseKeypress, input/termio/(tokenize,ansi,csi) | 933 |
| U3 输入管道 | input/(stdin, parsedKeyToInkKey, inputBus, InputProvider, useInput, protocol), hooks/useDoublePress, permissionQueue | 480 |
| U4 命令 | commands/(registry, sessionStore, terminalSetup, types) | 906 |
| U5 渲染/输入框 | components/(StreamRenderer, InputBox, textBuffer, pasteFold, pasteLabels) | 757 |
| U6 选择列表/模型选择 | components/(SelectList, selectListCore, ModelSelect, modelSelectItems, CommandMenu, commandMenuCore, PermissionDialog) | 549 |
| U7 markdown+其余组件+顶层 | components/markdown/*, toolSummary, Banner, UsageFooter, editDiff, Spinner, MessageList, userEcho, figures, App, index, types, toolOutputFile, hooks/useTerminalSize | ~1300 |

### server(2867 行 → 3 片;devPage 不审)
| 片 | 文件 | ~行 |
|----|------|-----|
| S1 SessionManager | session/SessionManager | 822 |
| S2 会话生命周期/存储 | session/(SessionService, sessionStore, createSession, events, SessionRegistry, testFakes) | 646 |
| S3 http/ws/auth/启动 | http/(server, cookies), ws/(wsServer, clientMessage), auth/*, config, cliArgs, bin, startServer, index | ~780 |

> 注:S1/S2/S3 大部分刚在本分支被 `/simplify`(diff 范围)+ 本轮清理过,预期发现少;仍纳入以"全覆盖"。

## web 待办(已审，择优应用)
4 角度共识里**值得做**的(其余多为稳定旧码上的小项/误报，跳过）:
- **效率·热路径**(聊天流每个 delta 都跑):`store.tsx` Context value 用 `useMemo` 稳定 identity；`Markdown.tsx` 把 remark/rehype 插件数组与 components 提到组件外(或 useMemo)避免每次重解析；`Message` 用 `React.memo`(避免 #50 消息来 delta 时 #1–49 全重渲染）；`MessageList` 合并两个 scrollIntoView effect。
- **简化**:`TodosPanel` 状态→`{cls,icon}` 查表替代成对三元；`Message.tsx` 抽 `getText(parts)` 去掉两处重复；`ws/client.ts` 抽 `cleanupSocket()`。
- **高度**(择一,低风险优先):`Message.tsx` 的 TodoWrite 抑制移到 reducer（表现层不该含工具语义）;`reducer.ts` 系统消息 id 用 `nextId('sys')` 而非 `messages.length`（防中途删除后碰撞)。
- 跳过:store refs(标准惯用法)、Header force-update(主题在 React 外，改造成本>收益，记 follow-up)、Composer 魔数 168(无关紧要)。

## 完成判据
每片:4 角度跑完、修复应用、`tsc --noEmit` 干净、相关 vitest 绿、该片小结(修了/跳了)。全仓扫完出总表。绝不为清理而改变行为。
