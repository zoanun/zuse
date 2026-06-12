# Zuse 鲁棒性与恢复设计(Phase 11)

> 2026-06-12。Phase 11 = 故障注入与恢复:harness 要假设**模型和环境都会出错**。
> 本期大部分机制在前期已顺手做掉(retry.ts 退避重试、stream-idle.ts 空闲守卫、
> agent 的 max_tokens 告警),所以工作量集中在两件事:**审计现状 → 补故障注入测试
> 锁住行为**;以及唯一的行为变更——**坏 JSON tool_use 从「中止回合」改为「回喂模型自纠」**。

## 1. 现状审计(路线图四要点逐条比对)

| 路线图要点 | 现状 | 本期动作 |
| --- | --- | --- |
| 流中途 kill → Esc 真能取消 | `StreamIdleGuard` 把外部 signal 与空闲超时合并接到 SDK;client 级测试已锁(openai-client.test.ts「中断与空闲超时」) | agent 级补一条:signal aborted → `Interrupted.` 告警 + **staged 全弃不提交** |
| 坏 JSON tool_use → 回喂 | OpenAIClient 对非法参数串产出 `error` **中止整回合**(连同已流出的文本一起作废) | **行为变更**,见 §2 |
| 撞 max_tokens → 告警 | agent.ts 已做(`stop_reason === 'max_tokens'` → warning) | 无测试,补测试锁住 |
| 429/5xx 退避、区分可否重试 | retry.ts(isRetryableError/backoffMs/classifyError)单测齐全;OpenAIClient 重试集成测试齐全 | AnthropicClient 的重试循环是**镜像副本但零测试**(构造器无 SDK 注入口),补注入 + 镜像测试 |

## 2. 行为变更:坏 JSON tool_use 回喂(D1)

**问题**:弱模型 / 本地端点(vLLM、Ollama)截断或拼错 tool_call 参数 JSON 并不罕见。
现行为是产出 `error` → agent 中止回合、staged 全弃:用户白等一轮,模型也没机会自纠。
这违背 Phase 8 的 observation contract 精神——模型的错误应转化为它能据此行动的 observation。

**新行为**(仅 OpenAI 协议路径,理由见 D2):

1. client 解析失败时不再 `error` 中止,改产出 `tool-use` 事件,带新可选字段
   `invalid_args: string`(原始非法串,截 200 字符),`input` 填 `{}` 占位
   ——staged 的 assistant tool_use 块必须可序列化重放(`JSON.stringify({})` 合法)。
2. agent 收集到带 `invalid_args` 的 tool_use 时:**跳过权限闸与执行**,直接合成
   is_error tool_result 回喂:
   `Tool call arguments were not valid JSON (tool: <name>). Raw arguments (truncated): <raw>. Re-issue the tool call with well-formed JSON arguments.`
3. stop_reason 仍是 `tool_use` → 循环自然继续,模型下一轮看到错误并重发。

**设计决策**:

- **D1 字段而非新事件类型**:在 `tool-use` 变体上加可选 `invalid_args`,而非新增
  `tool-use-invalid` 事件。TUI 与一切既有消费者零改动(它们看到的是一次普通
  tool-use + 一条红色错误 tool-result);只有 agent 读这个字段。
- **D2 Anthropic 路径不做**:Anthropic SDK 自己拼装解析 `input_json_delta`,且服务端
  保证 tool_use.input 是合法 JSON;`finalMessage()` 若真抛错走现有 error 路径。
  风险面集中在 OpenAI 兼容端点(参数串由模型逐片生成、无服务端校验)。
- **D3 id 兜底**:OpenAI 规范 tool_call 必带 id,但弱端点可能缺;缺时合成
  `invalid-json-<index>`,保证 tool_use/tool_result 配对不破角色合法性。
- **D4 部分非法不连坐**:同轮多个 tool_call 中一个非法、其余合法 → 合法的照常
  过闸执行,非法的单独回喂错误。并发判定(`allReadOnly`)把非法调用排除在执行批外。

## 3. AnthropicClient 可测性(D5)

重试/中断/空闲逻辑在两个 client 里各有一份镜像循环,OpenAIClient 因构造器可注入
sdk 而被完整测试,AnthropicClient 不可注入 → 零覆盖。本期给 AnthropicClient 构造器
加同款 `sdk?: Anthropic` 注入参数(仅测试用,生产路径仍懒加载),补三类镜像测试:

- 首次 `stream()` 抛 429、第二次正常 → 透明重试成功,无 error 事件;
- 已产出首个事件后才断流 → 不重试,error 事件,`stream` 仅调用一次……(防重复文本);
- 不可重试错误(401)直接 error 不重试。

## 4. 测试清单(故障注入)

| 注入点 | 断言 |
| --- | --- |
| agent:signal 已 aborted | warning `Interrupted.`,conversation 零提交 |
| agent:stop_reason=max_tokens | warning 含「max_tokens 处被截断」,本回合**照常提交**(半截文本仍是用户可见内容,只是带告警) |
| agent:tool-use 带 invalid_args | 工具未执行(spy 零调用)、tool_result is_error 含重发指引、循环继续、账本角色合法 |
| OpenAIClient:非法参数串 | 产出带 invalid_args 的 tool-use(改写原「error 中止」测试)、随后 message-stop 正常 |
| OpenAIClient:空参数串 | 仍按 `{}` 处理(现行为不变,锁住) |
| AnthropicClient:429→成功 / emitted 后断流 / 401 | 见 §3 |

## 5. 非目标

- 不做模型 fallback / fast-mode 降级(retry.ts 头注已记录的有意从简,模型切换由
  TUI 的 failover 编排负责)。
- 不做 Anthropic 协议的坏 JSON 回喂(D2)。
- 坏 JSON 的「重发预算」不单独限次:回喂消耗 maxTurns(50)配额,模型反复发坏
  JSON 会被 maxTurns 兜底,无需新计数器。
