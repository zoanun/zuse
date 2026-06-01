# 第一批:`@zuse/core` 核心层

这一层和界面完全无关,只干一件事:**把"对话消息"发给模型 API,然后把模型吐出来的内容变成一串流式事件**。它定义了一套自己的、和具体厂商无关的类型,这样以后换厂商(Anthropic → OpenAI)时,上层界面代码一行都不用改。

5 个文件,职责如下:

| 文件 | 职责 |
|------|------|
| `types.ts` | 定义所有数据结构(消息、事件、用量、配置) |
| `model-client.ts` | 定义抽象接口 `ModelClient`(契约) |
| `anthropic-client.ts` | 用 Anthropic SDK 实现这个接口 |
| `env.ts` | 从 `.env`/环境变量读配置 |
| `index.ts` | 统一对外导出 |

---

## 1. types.ts —— 数据结构的"词汇表"

这里没有逻辑,只有类型定义。但它是整个项目的契约,先理解它,后面所有代码都好懂。

**`ContentBlock`** —— 一条消息的内容块。现在只有一种:`{ type: 'text', text }`。注释里说 Phase 3 会加 `tool_use` / `tool_result`(工具调用)。设计成"块数组"而不是单个字符串,就是为将来的多模态/工具调用留位置。

**`Message`** —— 一条对话消息:`{ role: 'user'|'assistant', content: ContentBlock[] }`。这是发给模型的标准格式。

**`StreamEvent`** —— **核心中的核心**。模型流式返回时,会按顺序吐出这 4 种事件之一:

- `text-delta` —— 一小段新文字(打字机效果就靠它)
- `message-start` —— 回复开始,带上真实的消息 id 和模型名
- `message-stop` —— 回复结束,带上停止原因和本轮 token 用量
- `error` —— 出错了,带错误信息

整个流式协议就是这 4 个事件的序列。**上层界面只认这 4 个事件,不认 Anthropic SDK 的原始格式** —— 这就是解耦的关键。

**`Usage`** —— token 用量:`{ input_tokens, output_tokens }`。注释里 `cache_*` 字段是 Phase 6 的事。

**`ModelConfig`** —— 单次请求的参数:`{ model, max_tokens }`。`temperature` 留给 Phase 2+。

**`ClientConfig`** —— 建客户端要的东西:`{ apiKey, baseURL? }`。`baseURL` 可选 —— 不填就走 Anthropic 官方地址,填了就走兼容端点(比如 DashScope)。

---

## 2. model-client.ts —— 抽象接口(契约)

只定义了一个 `interface ModelClient`,两个方法:

- **`sendMessages(messages, config): AsyncIterable<StreamEvent>`** —— 把消息数组和配置丢进去,返回一个**异步可迭代对象**。调用方用 `for await...of` 一个一个地拿事件。这是流式的标准 JS 写法。
- **`getModel(): string`** —— 返回当前模型名,纯粹给界面显示用。

注释点明了意图:**Phase 1 实现 `AnthropicClient`,Phase 6 再实现 `OpenAIClient`**。因为上层只依赖这个接口,到时候加 OpenAI 不影响界面。

还有个 `ModelClientFactory` 类型(`(config) => ModelClient`),是"工厂函数"的签名,目前没怎么用到,属于预留。

---

## 3. anthropic-client.ts —— 真正干活的实现

`class AnthropicClient implements ModelClient`,这是 Phase 1 唯一的实现。

**构造函数** —— 用 `config` 里的 `apiKey`/`baseURL` new 一个官方 `Anthropic` SDK 实例;模型名优先用传进来的,否则调 `getDefaultModel()` 兜底。

**`sendMessages` —— 核心方法,逐步拆解:**

1. **格式转换**:把我们自己的 `Message[]` 转成 Anthropic SDK 要的 `MessageParam[]`。目前只处理 `text` 块,其它块原样透传。

2. **发起流式请求**:`this.client.messages.stream({...})`,拿到一个 SDK 的事件流。

3. **翻译事件循环** —— 这是这个类的灵魂。它把 SDK 的原始事件**翻译成我们自己的 `StreamEvent`**:
   - SDK 的 `message_start` → 我们的 `message-start`,带上**真实的** `event.message.id` 和 `event.message.model`(这正是 code review 修的 bug:以前在循环外用空字符串提前发了,真实值被丢弃)。
   - SDK 的 `content_block_delta` 且是 `text_delta` → 我们的 `text-delta`。
   - SDK 的 `message_delta` 且有 `stop_reason` → 调 `stream.finalMessage()` 拿到完整用量,组装成 `message-stop` 发出。

4. **错误兜底**:整个过程出任何异常,catch 住并 `yield` 一个 `error` 事件 —— 错误也走同一条事件流,上层不用单独 try/catch。

文件末尾 **`createAnthropicClientFromEnv()`** —— 便捷工厂:调 `getClientConfig()` 读环境,直接 new 一个客户端。界面层就用这个。

---

## 4. env.ts —— 配置加载

不依赖 `dotenv`,自己实现了一个极简加载器。

- **`findProjectRoot()`**:从当前目录往上找,直到找到 `pnpm-workspace.yaml`,把那一层当项目根。这样不管从哪个子包启动,都能定位到根目录的 `.env`。

- **`loadDotEnv(path)`**:手写的 `.env` 解析。逐行读、跳过空行和 `#` 注释、按第一个 `=` 切成 key/value。**关键**:只有当 `key` 不在 `process.env` 里才写入 —— 即**真实环境变量优先级高于 `.env` 文件**。模块加载时立刻执行一次。

- **`getClientConfig()`**:决定用哪套凭证。逻辑是:
  1. 如果设了 `DASHSCOPE_API_KEY` → **必须**同时有 `DASHSCOPE_BASE_URL`,否则抛错。(这是 code review 修的:以前两者独立兜底,可能把 DashScope 的 key 发到 Anthropic 官方地址,报一个莫名其妙的 401。)
  2. 否则用 `ANTHROPIC_API_KEY` + 可选的 `ANTHROPIC_BASE_URL`(不填走官方)。
  3. 两个 key 都没有 → 抛错提示。

- **`getDefaultModel()`**:模型名优先级 `ZUSE_MODEL` > `DASHSCOPE_MODEL` > 写死的 `claude-sonnet-4-5-20250514`。

- **`getDefaultMaxTokens()`**:读 `ZUSE_MAX_TOKENS`,解析成正整数,否则默认 `4096`。

---

## 5. index.ts —— 桶文件(barrel)

就是个 `export *`,把上面 4 个文件的内容统一从 `@zuse/core` 这个包名导出。界面层只 `import { ... } from '@zuse/core'` 就够了。

---

**一句话串起来:** 界面调 `createAnthropicClientFromEnv()`(env+anthropic-client)拿到一个符合 `ModelClient` 接口(model-client)的对象 → 调它的 `sendMessages` → 拿到一串 `StreamEvent`(types)→ 渲染。core 层对"界面长啥样"一无所知。
