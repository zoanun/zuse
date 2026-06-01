# 第二批:`@zuse/tui` 界面层

这一层是基于 **React + Ink** 的终端界面。core 层只管"把消息发给模型、吐出流式事件",这一层管"画界面 + 接住用户输入 + 消费那串事件"。

9 个文件,职责如下:

| 文件 | 职责 |
|------|------|
| `index.tsx` | 入口,启动 Ink 渲染 |
| `App.tsx` | 搭界面骨架 + 把 hook 和组件接起来 |
| `types.ts` | 界面专用的数据结构(`UIMessage` / `ConversationState`) |
| `hooks/useConversation.ts` | **大脑**:存对话状态、跑流式、所有逻辑 |
| `components/MessageList.tsx` | 把消息数组铺成列表 |
| `components/StreamRenderer.tsx` | 单条消息怎么画(用户框 / 助手 ● 回复) |
| `components/Spinner.tsx` | 流式时圆点转圈(无依赖) |
| `components/InputBox.tsx` | 底部输入框 |
| `components/UsageFooter.tsx` | 底部状态栏(模型 / 总 token / 思考中) |

---

## 先建立心智模型:Ink = 终端里的 React

记住三句话:

1. **组件是一个返回"界面描述"的函数**。这里的界面不是网页 `<div>`,而是 Ink 的 `<Box>`(布局,相当于 flexbox 容器)和 `<Text>`(文字)。Ink 把这些描述画到终端。
2. **数据单向流动**:状态在上面,通过 props 一层层往下传。子组件不改状态,只展示。
3. **状态一变,界面自动重画**。不用手动刷新某一行,只要改 state,Ink 会算差异、重绘变化部分。打字机效果就是"每来一小段文字 → 改 state → 自动重画"。

---

## 数据流全景

```
index.tsx  →  render(<App/>)            启动,把 App 挂到终端
   App.tsx                              搭骨架 + 接线
     ├─ useConversation()               大脑:存对话状态 + 跑流式
     ├─ <MessageList>                   把消息数组铺出来
     │     └─ <StreamRenderer>          单条消息怎么画
     │            └─ <Spinner>          流式时圆点转圈
     ├─ <UsageFooter>                   底部状态栏
     └─ <InputBox>                      输入框,回车触发 sendMessage
```

用户在 `InputBox` 回车 → 调 `App` 传下来的 `sendMessage` → `useConversation` 改状态 → 相关组件自动重画。**界面组件全是"哑的",逻辑集中在 `useConversation`。**

---

## 1. index.tsx —— 入口

4 行:`render(<App />)`。`#!/usr/bin/env tsx` 让这个文件能被 tsx 直接当脚本跑(`pnpm dev` = `tsx src/index.tsx`)。

---

## 2. App.tsx —— 骨架 + 接线

- **客户端初始化兜底**:开头 `try/catch` new 客户端。`.env` 没配好时 `createAnthropicClientFromEnv()` 抛错,抓进 `initError`,直接渲染一个红色错误页提示检查 `.env`。
- **正常布局**:纵向 flex —— 标题栏 / 消息区(`flexGrow={1}` 占满中间)/ 底部状态栏 / 输入框。
- 它本身**不存任何对话数据**,全靠 `useConversation` 给的 `state` 和 `sendMessage`。

---

## 3. types.ts —— 为什么界面层要再定义一个 `UIMessage`?

core 已有 `Message`,这里却另起 `UIMessage`:

```ts
interface UIMessage { id; role; text: string; isStreaming; usage? }
```

区别关键:

- core 的 `Message.content` 是**结构化块数组**(`ContentBlock[]`),那是给 API 的格式。
- `UIMessage.text` 是**拍平的纯字符串**,外加界面才关心的字段:`id`(React 列表 key)、`isStreaming`(要不要转圈)、`usage`(这条回复用了多少 token)。

这就是"界面模型"与"传输模型"分离:界面要"好渲染",API 要"符合协议"。两者在 `useConversation` 里互转。`ConversationState` 则是整个会话的 UI 状态:消息数组 + `isThinking` + `totalUsage` + `error`。

---

## 4. hooks/useConversation.ts —— 大脑(整层最重要)

一个 `useState` 存 `ConversationState`。核心是 `sendMessage`,四步:

1. **乐观更新**:用户一回车,立刻往消息数组塞**两条**——一条用户消息,一条**空的**助手占位消息(`text: ''`, `isStreaming: true`)。界面瞬间有反应(你的框出现 + 圆点开始转),不等网络。

2. **拼历史**:把已有消息(过滤掉还在流式的)转成 core 的 `Message[]`,再追加这次新输入。**这就是"服务端无状态、每轮重发整段历史"的地方**——`input_tokens` 随对话变长而单调增大的根源(模型没记忆,靠每轮重喂上下文)。

3. **消费事件流**:`for await...of client.sendMessages(...)` 逐个拿 `StreamEvent`(core 层吐出的 4 种):
   - `text-delta` → 累加进 `accumulatedText`,**按 id 定位那条助手消息、原地更新 text**。每段改一次 state → Ink 重画 → 打字机效果。
   - `message-stop` → 把那条标记 `isStreaming: false`、记上本轮 usage,并**累加**进 `totalUsage`(底部状态栏用)。
   - `error` → 把错误写进那条消息的 text,并 `break`。

4. **catch 兜底**:连接层面(还没进事件流就炸)的异常在外层 catch 兜住,写进消息 text。

> "按 id 找到消息、不可变地替换"(`messages.map(m => m.id === id ? {...m, text} : m)`)是 React 标准套路:不改原对象,而是造新数组,React 才知道"变了、该重画"。

---

## 5. components/MessageList.tsx —— 列表渲染

无逻辑,`messages.map` 出一堆 `<StreamRenderer>`,空数组返回 `null`。`key={msg.id}` 让 React 稳定跟踪每条消息(这也是 `UIMessage` 要带 `id` 的原因)。

---

## 6. components/StreamRenderer.tsx —— 单条消息长啥样

- **用户消息**:绿色圆角框(`borderStyle="round"` `borderColor="green"`)。
- **助手消息**:左列一个 marker(流式时是 `<Spinner>` 转圈,结束后是静态黄色 `●`),右列是正文 + token 行。

marker 单独成一列 + `marginRight` 撑间距,是为了:换行时正文能对齐(悬挂缩进),且圆点和文字之间的空隙不会被 flex 布局裁掉(这正是早期"丢冒号/换行难看"那个 bug 的根因——两个 `<Text>` 并排时尾随空格被 Yoga 裁掉)。

---

## 7. components/Spinner.tsx —— 无依赖转圈

`useEffect` 里开一个 `setInterval`,每 80ms 帧号 +1,循环盲文点 `⠋⠙⠹…`。`useEffect` 返回的 `clearInterval` 是**清理函数**:组件卸载(回复结束、Spinner 被静态 ● 替换)时自动停掉定时器,不泄漏。只在当前流式的那条消息上存在一个实例,开销可忽略。

---

## 8. components/InputBox.tsx —— 输入框

用第三方 `ink-text-input` 管理光标和输入。本地 `useState` 存当前输入值。回车 `handleSubmit`:非空且没在等响应才提交,然后清空。`isDisabled`(正在思考)时换 placeholder、关光标,从交互上禁止连发。

---

## 9. components/UsageFooter.tsx —— 底部状态栏

纯展示:模型名 + 累计总 token + 思考中提示。数据全从 props 来,自己不算东西。

---

**整层设计哲学(和 core 一致):逻辑集中、组件哑化。** 所有"会动"的东西都在 `useConversation` 里;每个组件单独看都只是"给我数据、我负责画",没有副作用。core 把"和模型对话"抽象成一串事件,tui 把这串事件"翻译"成不断变化的界面——两层通过 `StreamEvent` 这个契约解耦,换厂商时界面一行不用动。
