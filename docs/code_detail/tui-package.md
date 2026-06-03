# 第二批:`@zuse/tui` 界面层

这一层是基于 **React + Ink** 的终端界面。core 层管"和模型对话 + 驱动工具循环 + 吐流式事件",这一层管"画界面 + 接住用户输入 + 消费那串事件 + 斜杠命令"。

文件结构(按目录):

| 文件 | 职责 | 阶段 |
|------|------|------|
| `index.tsx` | 入口,启动 Ink 渲染 | P1 |
| `App.tsx` | 搭界面骨架 + 把 hook/组件/工具登记表接起来 | P1→P3 |
| `types.ts` | 界面专用数据结构(`UIMessage` / `UIToolCall` / `ConversationState`) | P1→P3 |
| `hooks/useConversation.ts` | **大脑**:状态、跑 `runAgent`、消费事件、斜杠分发 | P1→P3 |
| `components/MessageList.tsx` | 把消息数组铺成列表 | P1 |
| `components/StreamRenderer.tsx` | 单条消息怎么画(用户框 / 助手 ● / **工具块** / 系统提示) | P1→P3 |
| `components/Spinner.tsx` | 流式时圆点转圈(无依赖) | P1 |
| `components/InputBox.tsx` | 底部输入框 | P1 |
| `components/UsageFooter.tsx` | 底部状态栏(模型 / 总 token / 上下文大小 / 思考中) | P1→P2 |
| `commands/types.ts` | `SlashCommand` + `CommandContext` 契约 | P2 |
| `commands/registry.ts` | 命令表 + 解析(`/help` `/clear` `/save` `/load`) | P2 |
| `commands/sessionStore.ts` | 会话存档读写(`~/.zuse/sessions`) | P2 |

---

## 先建立心智模型:Ink = 终端里的 React

记住三句话:

1. **组件是一个返回"界面描述"的函数**。这里不是网页 `<div>`,而是 Ink 的 `<Box>`(布局,相当于 flexbox 容器)和 `<Text>`(文字)。Ink 把这些描述画到终端。
2. **数据单向流动**:状态在上面,通过 props 一层层往下传。子组件不改状态,只展示。
3. **状态一变,界面自动重画**。不用手动刷新某一行,只要改 state,Ink 会算差异、重绘变化部分。打字机效果就是"每来一小段文字 → 改 state → 自动重画"。

---

## 数据流全景

```
index.tsx  →  render(<App/>)            启动,把 App 挂到终端
   App.tsx                              搭骨架 + 接线(client + registry)
     ├─ useConversation()               大脑:状态 + 跑 runAgent + 斜杠分发
     ├─ <MessageList>                   把消息数组铺出来
     │     └─ <StreamRenderer>          单条消息怎么画(按 role 分支)
     │            └─ <Spinner>          流式 / 工具运行时圆点转圈
     ├─ <UsageFooter>                   底部状态栏
     └─ <InputBox>                      输入框,回车触发 submit
```

用户在 `InputBox` 回车 → 调 `submit` → `useConversation` 判断是斜杠命令还是聊天 → 改状态 → 相关组件自动重画。**界面组件全是"哑的",逻辑集中在 `useConversation`。**

---

## 1. index.tsx —— 入口

几行:`render(<App />)`。`#!/usr/bin/env tsx` 让这个文件能被 tsx 直接当脚本跑(`pnpm dev` = `tsx src/index.tsx`)。

---

## 2. App.tsx —— 骨架 + 接线

- **工具登记表建一次**:模块顶层 `const registry = createDefaultRegistry()`(来自 `@zuse/tools`)。整个会话工具集固定,所以放组件外、只建一次,再当 prop 传给 `useConversation`。
- **客户端初始化兜底**:开头 `try/catch` new 客户端。`.env` 没配好时 `createAnthropicClientFromEnv()` 抛错,抓进 `initError`,直接渲染红色错误页提示检查 `.env`。
- **正常布局**:纵向 flex —— 标题栏 / 消息区(`flexGrow={1}` 占满中间)/ 底部状态栏 / 输入框。`isThinking` 时禁用输入框防连发。
- 它本身**不存任何对话数据**,全靠 `useConversation` 给的 `state` 和 `submit`。

---

## 3. types.ts —— 界面专用数据结构

core 已有 `Message`,这里另起一套"界面模型",因为界面要"好渲染",API 要"符合协议",两者关心的东西不同。

```ts
interface UIToolCall {                                  // P3:一次工具调用在界面上的样子
  name: string
  input: unknown
  status: 'running' | 'done'
  isError?: boolean
  output?: string   // 工具结果,status === 'done' 时填上
}

interface UIMessage {
  id: string                                            // React 列表 key
  role: 'user' | 'assistant' | 'system' | 'tool'        // P3 多了 system/tool
  text: string                                          // 拍平的纯文字
  isStreaming: boolean                                  // 要不要转圈
  usage?: Usage                                         // 仅 assistant 完成后
  tool?: UIToolCall                                     // 仅 role === 'tool'
}
```

四种 role 的含义:`user`/`assistant` 是真人和模型;**`system`** 是本地通知(斜杠命令的输出,如 "Saved to …"),不发给模型;**`tool`** 是一次工具调用 + 它的结果,`tool` 字段挂着 `UIToolCall`。

> 对比 core 的 `Message.content` 是结构化块数组(给 API),`UIMessage.text` 是拍平的字符串(给渲染)。两者在 `useConversation` 里互转。

**`ConversationState`** —— 整个会话的 UI 状态:`messages` + `isThinking` + `totalUsage` + **`contextTokens`**(上一回合的 `input_tokens`,即"当前上下文实时大小",故障模式②,底部状态栏用)+ `error`。

---

## 4. hooks/useConversation.ts —— 大脑(整层最重要)

它持有两个"非渲染"引用:
- `conversationRef`:一个 `Conversation` 实例,**权威历史**。放 ref 不放 state——改它不该触发重画,也不想在闭包里拿到过期副本。
- `abortRef`:一个 `AbortController`,让将来的 Ctrl+C/Esc 能中断进行中的回合(signal 已经一路穿到每个工具;真正的按键 → `abort()` 是 P5 的事)。

入口是 **`submit`**,先分流:
- `parseInput` 判断是不是斜杠命令。不是 → 走 `sendMessage`(聊天)。
- 是 → `findCommand` 找命令,找不到就 `print` 一条提示;找到就构造 `CommandContext`(把 `print` / `clear` / `conversation` / `load` 这些能力传进去)再 `cmd.run(ctx)`。

**`sendMessage` —— 核心,消费 `runAgent` 事件流:**

1. **乐观更新**:用户一回车,立刻塞一条用户消息、`isThinking = true`。界面瞬间有反应,不等网络。
2. **建 AbortController**,存进 `abortRef`。
3. **跑 `runAgent`**(注意:**不再直接调 `client.sendMessages`**,而是把 `conversation` / `client` / `registry` / `userText` / `config` / `cwd: cwd()` / `signal` 全交给 `runAgent`,由它驱动模型↔工具循环)。一个回合可能经历好几趟模型往返,所以维护 `currentAssistantId`(当前助手气泡)和 `toolBubbleId`(把每个 tool_use id 映射到屏上的工具气泡)。
4. **按事件类型更新 UI**:
   - `message-start` → 新建一个空助手气泡(`isStreaming: true`),记下它的 id。
   - `text-delta` → 累加文字,按 id 原地更新那条助手气泡(打字机)。
   - `tool-use` → 把当前助手气泡收尾(`isStreaming: false`),新建一个 `role: 'tool'` 气泡(`status: 'running'`),并把 `event.id → 气泡 id` 记进 `toolBubbleId`。
   - `tool-result` → 用 `toolBubbleId` 找到对应工具气泡,填上 `status: 'done'` / `isError` / `output`。
   - `message-stop` → 记下 `input_tokens`(给 `contextTokens`),给助手气泡标完成 + 记 usage。
   - `warning` → 追加一条 `system` 消息(如 "Reached max turns…")。
   - `error` → 把错误写进当前助手气泡(没有就新建一条),并存进 `state.error`。
5. **回合结束**:`runAgent` 已经原子提交了整轮(成功)或啥都没提交(出错),所以直接从 `conversation` 读 `totalUsage`,`contextTokens` 取这轮的 `input_tokens`。
6. **catch 兜底** + `finally` 清掉 `abortRef`。

另外几个能力:**`clear`**(清 conversation + UI)、**`print`**(往 transcript 追加一条 system 通知,斜杠命令用)、**`load`**(换上一个加载进来的 Conversation,并从它的历史重建 UI 列表)。

> "按 id 找消息、不可变替换"(`messages.map(m => m.id === id ? {...m, ...} : m)`)是 React 标准套路:造新数组,React 才知道"变了、该重画"。

---

## 5. components/MessageList.tsx —— 列表渲染

无逻辑,`messages.map` 出一堆 `<StreamRenderer>`,空数组返回 `null`。`key={msg.id}` 让 React 稳定跟踪每条消息。

---

## 6. components/StreamRenderer.tsx —— 单条消息长啥样

按 `role` 分支:

- **`tool`(P3)**:渲染 `<ToolBlock>` —— 一行青色 `名字(参数)`,左边一个状态 marker:运行中是 `<Spinner>`,完成是绿 `✓` / 红 `✗`。下面跟一行结果预览(输出第一行,截 80 字;出错前缀 `error:`)。`summarizeInput` 把参数压成一行(有 `file_path` 就显示路径,否则显示截断的 JSON)。
- **`system`**:本地通知(斜杠命令输出),暗色、无框。
- **`user`**:绿色圆角框。
- **`assistant` 且无文字**(纯工具调用的那趟):返回 `null`——可见内容由工具块承载。
- **`assistant`**:左列 marker(流式时 `<Spinner>`,结束后静态黄 `●`)单独成列,右列正文 + token 行。

> marker 单独成列 + `marginRight` 撑间距,是为了换行时正文对齐(悬挂缩进),且圆点和文字间的空隙不会被 flex 布局裁掉(早期"丢冒号/换行难看"那个 bug 的根因——两个 `<Text>` 并排时尾随空格被 Yoga 裁掉)。

---

## 7. components/Spinner.tsx —— 无依赖转圈

`useEffect` 里开 `setInterval`,每 80ms 帧号 +1,循环盲文点 `⠋⠙⠹…`。`useEffect` 返回的 `clearInterval` 是清理函数:组件卸载(回复结束 / 工具完成,Spinner 被静态符号替换)时自动停掉定时器,不泄漏。

---

## 8. components/InputBox.tsx —— 输入框

用第三方 `ink-text-input` 管理光标和输入。本地 `useState` 存当前值。回车 `handleSubmit`:非空且没在等响应才提交,然后清空。`isDisabled`(思考中)时换 placeholder、关光标,从交互上禁止连发。

---

## 9. components/UsageFooter.tsx —— 底部状态栏

纯展示:模型名 + 累计总 token + **当前上下文大小**(`contextTokens`,超 100k 变黄提示)+ 思考中提示。数据全从 props 来,自己不算东西。

---

## 10. commands/ —— 斜杠命令(P2)

**`types.ts`** —— 两个契约。`CommandContext` 是命令运行时拿到的"能力包":`args` / `print` / `clear` / `conversation` / `load`。命令只通过这些能力做事,**不碰 React**,所以和界面解耦。`SlashCommand` = `{ name, description, run(ctx) }`。

**`registry.ts`** —— 命令表 `COMMANDS = [help, clear, save, load]`,**加命令 = 加一个表项**(数据驱动)。
- `/help` 列出所有命令;`/clear` 清空;`/save <name>` 序列化存盘;`/load <name>` 读盘并替换当前会话。
- `parseInput(input)` 把原始输入切成 `{ name, args }`,不是 `/` 开头就返回 `null`(当普通聊天)。`findCommand(name)` 查表。

**`sessionStore.ts`** —— 存档读写,落在 `~/.zuse/sessions/<name>.json`。
- **`safeName(name)`** 把用户给的名字洗成单个安全路径段(只留 `a-zA-Z0-9_.-`,挡掉 `/`、`..`),**防路径穿越**——`/save ../../etc/foo` 跑不出 sessions 目录。
- `saveConversation` 写 `conv.toJSON()`;`loadConversation` 读文件、`JSON.parse`、`Conversation.fromJSON`(里头会校验 `version`),文件不存在就抛友好错误。

---

**整层设计哲学(和 core 一致):逻辑集中、组件哑化。** 所有"会动"的东西都在 `useConversation` 里;每个组件单独看都只是"给我数据、我负责画"。core 把"和模型对话 + 跑工具"抽象成一串 `StreamEvent`,tui 把这串事件翻译成不断变化的界面——两层通过 `StreamEvent` 这个契约解耦,换厂商时界面一行不用动。
