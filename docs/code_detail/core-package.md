# 第一批:`@zuse/core` 核心层

这一层和界面完全无关,它定义了一套**和具体厂商无关的类型**,并实现了三件事:**把对话消息发给模型、把模型吐出来的内容变成一串流式事件、驱动"模型↔工具"的回合循环**。以后换厂商(Anthropic → OpenAI)时,上层界面代码一行都不用改。

8 个源文件(另有同名 `*.test.ts`),职责如下:

| 文件 | 职责 | 阶段 |
|------|------|------|
| `types.ts` | 定义所有数据结构(消息、内容块、事件、用量、配置) | P1→P3 |
| `model-client.ts` | 定义抽象接口 `ModelClient`(契约) | P1→P3 |
| `anthropic-client.ts` | 用 Anthropic SDK 实现这个接口 | P1→P3 |
| `env.ts` | 从 `.env`/环境变量读配置 | P1 |
| `conversation.ts` | 已提交对话历史的权威存储 + 存档序列化 | P2 |
| `tool.ts` | `Tool` 接口 + `ToolRegistry`(工具的定义与登记) | P3 |
| `agent.ts` | `runAgent` —— Agent 循环,本层的心脏 | P3 |
| `index.ts` | 统一对外导出(barrel) | P1→P3 |

---

## 1. types.ts —— 数据结构的"词汇表"

这里没有逻辑,只有类型定义。但它是整个项目的契约,先理解它,后面所有代码都好懂。

**`ContentBlock`** —— 一条消息的内容块,**三种**(P3 已补齐):

```ts
type ContentBlock =
  | { type: 'text'; text: string }                                      // 普通文字
  | { type: 'tool_use'; id: string; name: string; input: unknown }      // 模型要调工具
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }  // 回填工具结果
```

设计成"块数组"而不是单个字符串,就是为了装下工具调用。关键点:`tool_use` 和 `tool_result` 靠 **id 配对**——模型发的 `tool_use.id`,和我们回填的 `tool_result.tool_use_id` 必须一致。`input: unknown` 是诚实表示:模型产出的 JSON 形状未知,由各工具自己收窄校验。

**`Message`** —— 一条对话消息:`{ role: 'user' | 'assistant', content: ContentBlock[] }`。注意只有两个角色。**工具结果不是第三种角色**——它以 `tool_result` 块的形式,塞进一条 `role: 'user'` 的消息里发回去(这是 Anthropic 协议要求:对话严格 user/assistant 交替,凡"模型之外反馈给它的东西"都算 user)。

**`StreamEvent`** —— **核心中的核心**。一个回合里按顺序吐出的事件,**7 种**,分两批来源:

前 4 种由 **ModelClient**(和模型对话)发出:
- `message-start` —— 回复开始,带真实消息 id 和模型名
- `text-delta` —— 一小段新文字(打字机效果靠它)
- `tool-use` —— 模型决定调某个工具(带 id/name/input)
- `message-stop` —— 本趟回复结束,带停止原因和 token 用量

后 3 种由 **Agent 循环**(`runAgent`,执行工具的那一层)发出:
- `tool-result` —— 某个工具跑完了(带 output / is_error),给 UI 实时变状态
- `warning` —— 非致命提示(撞上 max_turns、被中断)
- `error` —— 出错了,带错误信息

**上层界面只认这 7 个事件,不认 Anthropic SDK 的原始格式**——这就是解耦的关键。

**`Usage`** —— token 用量:`{ input_tokens, output_tokens }`。

**`ModelConfig`** —— 单次请求参数:`{ model, max_tokens }`。

**`ClientConfig`** —— 建客户端要的东西:`{ apiKey, baseURL? }`。`baseURL` 可选——不填走 Anthropic 官方,填了走兼容端点(如 DashScope)。

---

## 2. model-client.ts —— 抽象接口(契约)

一个 `interface ModelClient`,两个方法:

- **`sendMessages(messages, config, tools?): AsyncIterable<StreamEvent>`** —— 把消息数组、配置、**可选的工具清单**丢进去,返回一个异步可迭代对象。调用方用 `for await...of` 一个个拿事件。第三参 `tools?: ToolDefinition[]` 是 P3 新增,**可选**,所以 P2 不传也照样跑(向后兼容);传了,模型才可能发 `tool-use` 事件。
- **`getModel(): string`** —— 返回当前模型名,给界面显示用。

注释点明意图:**P1 实现 `AnthropicClient`,以后再实现 `OpenAIClient`**。上层只依赖这个接口,换厂商不影响界面。还有个预留的 `ModelClientFactory` 类型(`(config) => ModelClient`)。

---

## 3. anthropic-client.ts —— 真正干活的实现

`class AnthropicClient implements ModelClient`,目前唯一的实现。

**构造函数** —— 用 `config` 的 `apiKey`/`baseURL` new 一个官方 `Anthropic` SDK 实例;模型名优先用传进来的,否则 `getDefaultModel()` 兜底。

**`sendMessages` —— 核心方法,拆解:**

1. **格式转换(出)**:把我们的 `Message[]` 转成 Anthropic SDK 的 `MessageParam[]`。三种内容块几乎 1:1 映射:`text`→text、`tool_use`→tool_use、`tool_result`→tool_result。这层翻译是 client 的本职——把内部中立格式翻成具体厂商格式。

2. **按需带工具**:只有 `tools && tools.length > 0` 时才往请求里加 `tools` 字段(`...(tools?.length ? { tools } : {})`)。纯聊天时请求干干净净,不带工具字段。

3. **发起流式请求**:`this.client.messages.stream({...})`,拿到 SDK 的事件流。

4. **翻译事件循环** —— 这个类的灵魂,把 SDK 原始事件翻成我们的 `StreamEvent`:
   - SDK `message_start` → 我们的 `message-start`,带**真实**的 `event.message.id` / `event.message.model`。
   - SDK `content_block_delta` 且 `text_delta` → 我们的 `text-delta`(文字边流边发)。
   - SDK `message_delta` 且有 `stop_reason` → **先**调 `await stream.finalMessage()` 拿到拼装好的完整消息,遍历它的 content,对每个 `tool_use` 块 `yield` 一个 `tool-use` 事件;**然后**才 `yield` `message-stop`(带完整用量)。

   > 为什么工具调用要等 `finalMessage()`?因为流里的 `input_json_delta` 是一片片 JSON 碎片,自己拼容易出错;SDK 的 `finalMessage()` 会帮你拼成完整、已解析的 `input`。所以策略是:文字边流边发,工具调用等流结束、拿完整块再发。发射顺序也讲究——**先所有 tool-use,再 message-stop**,好让 Agent 循环先收齐工具、最后才看停止原因。

5. **错误兜底**:整个过程出任何异常,catch 住并 `yield` 一个 `error` 事件——错误也走同一条事件流,上层不用单独 try/catch。

文件末尾 **`createAnthropicClientFromEnv()`** —— 便捷工厂:调 `getClientConfig()` 读环境,直接 new 一个客户端。界面层就用这个。

---

## 4. conversation.ts —— 已提交历史的权威存储(P2)

`class Conversation`,**纯数据 + 操作,没有 React**。TUI 在一个 ref 里持有一个实例,再把"好渲染"的视图镜像进组件 state。

它存两样东西:`messages: Message[]`(权威历史)和 `_totalUsage`(累计 token)。

- **`append(message)`** + 便捷的 `appendUserText` / `appendAssistantText`。
- **`getMessages()`** —— 返回**防御性拷贝**(连 content 数组也复制一份),外部拿到也改不动内部。
- **`addUsage(usage)`** —— 把一个回合的用量累加进总数(故障模式⑧:跨回合累计)。
- **`clear()`** —— 清空历史 + 用量。
- **`toJSON()` / `static fromJSON()`** —— 存档序列化(`/save`、`/load` 用)。`ConversationSnapshot` 带一个 `version: 1` 字段,给将来的格式迁移留门。`fromJSON` 校验版本号,不认就抛错。

> 这个类就是"无状态服务器、每轮重发整段历史"那条铁律的载体——它存的 `messages` 正是每个回合要原样重发给模型的东西。

---

## 5. tool.ts —— 工具的定义与登记(P3)

定义"什么是工具",以及一个登记表。**纯定义 + 一个 Map,没有 I/O**。

- **`JSONSchema`** —— 工具输入的 JSON Schema(松类型),原样透传给厂商的 `tools` 参数,模型读它来决定怎么调。
- **`ToolContext`** —— 运行时上下文,交给工具的 `run`。P3 只带 `{ cwd, signal }`(工作目录 + 中断信号)。P5 会往这里加 `PermissionManager`。
- **`ToolResult`** —— `{ output: string; isError?: boolean }`。`output` 是喂回模型的文本;`isError: true` 标记失败,好让模型被告知"工具失败了",而不是默默当成功(故障模式④)。
- **`Tool`** —— 一个工具:`{ name, description, inputSchema, run(input: unknown, ctx) }`。`input` 是模型产出的非结构化 JSON,类型 `unknown`,**每个工具自己收窄并校验**。
  > 设计决策:`run` 用 `run(input: unknown, ...)` 而**不是**泛型 `run<T>`。泛型会在 `ToolRegistry` 里装一堆不同 `Tool<T>` 时引发类型变异(variance)报错;统一 `unknown`、各工具内部收窄,最干净。
- **`ToolDefinition`** —— `{ name, description, input_schema }`,发给厂商 API `tools` 参数的形状(注意是 snake_case 的 `input_schema`)。
- **`ToolRegistry`** —— `register`(重名抛错)/ `get(name)` / `list()` / `getDefinitions()`。Agent 循环用 `getDefinitions()` 告诉模型有哪些工具,用 `get(name)` 执行模型挑中的那个。

---

## 6. agent.ts —— `runAgent`,本层的心脏(P3)⭐

一个 **async generator**(`async function*`),驱动"问模型 → 跑工具 → 把结果喂回去 → 再问"的循环,一边干活一边 `yield` `StreamEvent`。UI 用 `for await` 订阅。`DEFAULT_MAX_TURNS = 50` 是死循环防线(故障模式①)。

**核心设计:暂存区 + 原子提交。** 一个回合产生的所有新消息先攒在本地 `staged` 数组里,**全程只攒不写**;只有干净跑完(`clean = true`)才在最后一次性 `append` 进 `conversation`。中途出错或被中断就 `return`,丢弃 `staged`,`conversation` 一个字没动。这样历史永远不会停在一条"悬空的 user/tool_result"上而破坏角色交替。

循环逐趟做的事:

1. 开头查 `signal.aborted`,被中断就 `yield warning` 然后 `return`。
2. `for await` 消费 `client.sendMessages([...base, ...staged], config, toolDefs)`——**每趟都重发"历史 + 本轮草稿"全量上下文**。一边累加 `text`、收集 `toolUses`、记下 `stopReason`,一边把事件转发给 UI。
3. 把这趟模型的输出(text + 若干 tool_use 块)重建成一条 `role: 'assistant'` 消息,推进 `staged`。
4. **分岔**:`stop_reason !== 'tool_use'`(模型说完了)→ `clean = true`,`break`,去提交;否则执行工具。
5. 执行每个工具(`runOneTool`),`yield tool-result` 给 UI,同时把结果攒成 `tool_result` 块;所有结果打包成**一条 `role: 'user'` 消息**推进 `staged`。循环回到第 2 步,这次模型就能看到工具结果了。**闭环。**
6. 出循环后:若是撞 `maxTurns`(`clean` 仍为 false),`staged` 最后一条是 user(tool_result),补一条 assistant 收尾保持交替,并 `yield warning`。最后**唯一一次**把整个 `staged` 顺序 `append` 进 `conversation`,用量也一次性累加。

**`runOneTool`** —— 把错误变成数据(故障模式④):未知工具名、或工具内部抛异常,都接住转成 `{ output, isError: true }`,以 `tool_result(is_error: true)` 喂回模型,让模型自己看到失败原因并自我纠正,而不是让程序崩溃。

---

## 7. env.ts —— 配置加载

不依赖 `dotenv`,自己实现了一个极简加载器。

- **`findProjectRoot()`**:从当前目录往上找,直到找到 `pnpm-workspace.yaml`,把那一层当项目根。这样不管从哪个子包启动,都能定位到根目录的 `.env`。
- **`loadDotEnv(path)`**:手写 `.env` 解析。逐行读、跳过空行和 `#` 注释、按第一个 `=` 切 key/value。**关键**:只有 `key` 不在 `process.env` 里才写入——即**真实环境变量优先级高于 `.env` 文件**。模块加载时立刻执行一次。
- **`getClientConfig()`**:决定用哪套凭证。
  1. 设了 `DASHSCOPE_API_KEY` → **必须**同时有 `DASHSCOPE_BASE_URL`,否则抛错(否则会把 DashScope 的 key 发到 Anthropic 官方地址,报莫名其妙的 401)。
  2. 否则用 `ANTHROPIC_API_KEY` + 可选 `ANTHROPIC_BASE_URL`。
  3. 两个 key 都没有 → 抛错提示。
- **`getDefaultModel()`**:`ZUSE_MODEL` > `DASHSCOPE_MODEL` > 写死的 `claude-sonnet-4-5-20250514`。
- **`getDefaultMaxTokens()`**:读 `ZUSE_MAX_TOKENS`,解析成正整数,否则默认 `4096`。

---

## 8. index.ts —— 桶文件(barrel)

`export *` 把全部 8 个模块(types / model-client / anthropic-client / env / conversation / tool / agent)统一从 `@zuse/core` 导出,外加一个 `VERSION` 常量。界面层和工具层只 `import { ... } from '@zuse/core'` 就够了。

---

**一句话串起来:** 界面调 `createAnthropicClientFromEnv()`(env + anthropic-client)拿到符合 `ModelClient` 接口的对象 → 连同一个 `Conversation` 和工具 `getDefinitions()` 交给 `runAgent`(agent)→ runAgent 用暂存区循环驱动"模型↔工具",一路 `yield` `StreamEvent`(types)→ UI 渲染。core 对"界面长啥样"一无所知。
