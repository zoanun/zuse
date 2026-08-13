# 步骤 5：把 run 服务暴露成模型工具

> 上游：`2026-08-11-code-exec-runner-v4-design.md` §10「明确的取舍：模型看不到运行输出」
> 与 §11 落地顺序第 5 条。步骤 2/3/4 已合入 master。
>
> **v2**：独立评审提了 7 条，全部属实、全部已改。改动最大的是 §5（游标）——
> v1 的公式在片段档下语义是**反的**，会把「尾部丢了」报成「开头丢了」；
> 以及 §5.2（双流游标）——v1 的单个标量 `since` 会让 **stderr 永久读不到**，
> 而 traceback 正在那条流上。两条都长在最核心的机制上，v1 上线会以
> 「模型读了输出但还是修不对」的形态回来。修订记录见 §12。

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

即 120s 默认 / 600s 上限、输出预算 head 10k + tail 20k。

### 2.3 `Run` 只能整份取快照，没有游标

```
$ sed -n '141,145p' packages/tools/src/run/run.ts
  /** 当前可见输出。中途接入的订阅者靠它补历史。 */
  snapshot(): { out: string; err: string } {
    return { out: this.sinks.out.snapshot(), err: this.sinks.err.snapshot() }
  }
```

`sinks` 是 `private`（`run.ts:95`）。`OutputSink` 上有 `totalChars`（**实际产生**的总字符数，
不是快照长度），但 `Run` 没把它转出去。项目档环形缓冲 400_000 字符，片段档 200_000
（`policy.ts`）。**一次全量回读就能把模型的上下文吃掉一大半。**

### 2.4 两档 sink 丢字符的方向**相反**

这是 v1 spec 最严重的错误的根源。`packages/tools/src/run/sink.ts` 原文：

```
export class TruncateSink implements OutputSink {
  push(text: string): void {
    if (text === '') return
    this.total += text.length
    const room = this.budget - this.buf.length
    if (room > 0) this.buf += text.slice(0, room)
    if (this.total > this.budget) this.over = true
  }
}
```

```
export class RingSink implements OutputSink {
  push(text: string): void {
    if (text === '') return
    this.total += text.length
    if (this.capacity <= 0) return
    this.buf = (this.buf + text).slice(-this.capacity)
  }
}
```

**TruncateSink 留的是最先来的（丢尾巴），RingSink 留的是最后来的（丢开头）。**
而两档都在用：

```
$ grep -n "isExec ? SNIPPET_POLICY : PROJECT_POLICY" packages/server/src/http/server.ts
1030:          () => (isExec ? SNIPPET_POLICY : PROJECT_POLICY),
```

步骤 3 的代码块运行走 truncate 档 —— **也就是「模型自己写的代码跑挂了」那个场景**。
所以 v1 那句「二者之差 = 已经被环形缓冲丢掉的前缀长度」只对 ring 成立，
在片段档下会把丢掉的尾部报成丢掉的头部。详见 §5.1 的推演。

### 2.5 右栏**已经在剥 ANSI 了**，而且比朴素写法更完整

v1 spec 写的是「读侧剥、右栏不剥，两侧诉求相反」。**前提是错的**：

```
$ sed -n '1,14p;31,33p' packages/web/src/exec/termText.ts
/**
 * 终端输出的文本处理（spec §4）。
 *
 * 一句话：把 run 服务推来的**增量** chunk 变成能直接渲染的文本。
 * 干三件事——归一化 CRLF、剥掉 ANSI、处理裸 `\r` 的「覆盖本行」。
 …
/** 完整的 CSI 序列。只做 strip，不做 ansi→span（v4 §8：实测 11 条命令 ESC 全为 0）。 */
const ANSI_FULL = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
/** 末尾**没写完**的那一截。增量场景下必须留到下一块，否则 `\x1b[3` | `1m` 会漏进正文。 */
const ANSI_TAIL = /\x1b(?:\[[0-9;?]*[ -/]*)?$/
    s = s.replace(ANSI_FULL, '')
    const tail = ANSI_TAIL.exec(s)
    if (tail) { this.pendingEsc = tail[0]; s = s.slice(0, tail.index) }
```

两侧诉求当下是**一致的**，该复用而不是各写一份。而且这份还处理了**裸 `\r` 的覆盖本行**——
v1 spec 通篇没提 `\r`，但进度条一行重绘几百次，不折叠就是把几百份几乎相同的行喂给模型，
**烧的 token 比 ANSI 多得多**。

### 2.6 共享落点：`@zuse/protocol` 是两侧唯一的公共祖先

```
$ node -e "…packages/tools/package.json"
tools deps: @mozilla/readability @vscode/ripgrep @zuse/core @zuse/protocol …
$ node -e "…packages/web/package.json"
web devDeps: … @zuse/protocol …            （web 只依赖 protocol，不依赖 core/tools）
$ grep -n "^export function" packages/protocol/src/index.ts
266:export function groupTodos<T extends { group?: string }>(
```

`@zuse/tools` 已经依赖 protocol，web 也是；且 protocol 里**已经有运行时纯函数的先例**
（`groupTodos`），不是纯类型包。把 web → tools 的边加出来是不可接受的（会把整个工具层
拖进浏览器包），protocol 是唯一不引入新依赖方向的落点。

### 2.7 会话隔离只在 HTTP 层；接缝只有一条拿得到 sessionId

```
$ grep -n "sessionId" packages/server/src/session/SessionManager.ts
147:  sessionId: string
231:  private readonly sessionId: string
321:    this.sessionId = opts.sessionId
$ grep -n "registerExtraTools?:" packages/server/src/session/createSession.ts
52:  registerExtraTools?: (registry: ToolRegistry) => void
```

`SessionManager` 手里有 sessionId，`SESSION_CAPABILITY_TOOLS` 就在同一个构造函数里消费
`SessionCapabilityContext`；另一条接缝 `registerExtraTools` **只有 registry**。

```
$ grep -n "new SessionService\|new RunRegistry\|const registerExtraTools" packages/server/src/startServer.ts
72:  const registerExtraTools = (registry: ToolRegistry): void => {
152:  const service = new SessionService({
220:  const runs = new RunRegistry({
```

220 行那段只依赖 `spawnShellCommand`/`killTree` 两个 import，与 152 行的 `service` 无关，
上移无依赖顺序风险（评审复核过）。

### 2.8 给模型注入现状：`applyUserStamp` 那条路**会污染账本**

```
$ grep -rn "stripUserStamp\|applyUserStamp" packages/server/src --include=*.ts | grep -v "\.test\."
packages/server/src/search/SearchService.ts:26:    const clean = m.role === 'user' ? stripUserStamp(text) : text
packages/server/src/session/SessionManager.ts:1283:        userText: applyUserStamp(text),
packages/server/src/session/SessionManager.ts:633:          const text = role === 'user' ? stripUserStamp(block.text) : block.text
packages/server/src/session/SessionManager.ts:1774:    const text = stripUserStamp(userMsg.content.map(…).join(''))
packages/server/src/session/SessionService.ts:350:        const text = stripUserStamp(block.text).trim()
```

`applyUserStamp` 注入的东西**进账本**，靠一个锚定正则 `^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}…\] `
剥回来，有 **4 个消费者**：网页气泡（633）、retry 重发（1774）、会话标题（Service:350）、
历史搜索（SearchService:26）。往这里拼别的东西 → 四处全漏。

**干净接缝在另一处**，`packages/core/src/agent.ts:272`：

```
    const outbound = opts.expandAttachments ? await opts.expandAttachments(messages) : messages
```

这是**请求专用副本**（注释原文：「产出请求专用副本」），不进账本、不进标题、不进搜索、
不被 retry 重发，且每回合按当时状态重算。

### 2.9 片段档的 `command` 认不出是哪一个

```
$ grep -n "command:\|label:" packages/tools/src/run/planExec.ts
31:      command: `uv run --no-project "${EXEC_DIR_PLACEHOLDER}/main.py"`,
33:      label: '用 uv 跑 Python',
43:    command: `java ${flags} "${EXEC_DIR_PLACEHOLDER}/Main.java"`,
45:    label: '用 java 单文件模式跑',
$ grep -n "label" packages/tools/src/run/registry.ts packages/tools/src/run/run.ts
（零命中）
```

`EXEC_DIR_PLACEHOLDER` 被替换成 `mkdtempSync` 的临时目录。所以三次 Python 运行的 command
**完全一样**，只差一段随机后缀，而真正的区分依据（代码本身）在 `RunSummary` 里没有任何投影。
`planExec` 产出的 `label` **没有存到 Run 上**。

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
   `name === 'Bash'` 换成工具自己声明的标记，让安全闸按**性质**而不是按**名字**生效。
   那是一次独立的 core 改动，需要自己的变异测试。
   **混进本步会让「模型能看输出」这件小事挂在一次权限层重构上。**
3. A 做完之后 B 只是加一个工具，读侧不用重写。反过来不成立。

**评审复核过这条取舍**并反向验证：用户点▶跑挂 → 模型读到报错 → 改代码 → 模型可以**自己用
Bash 验证**（600s 对片段绰绰有余）。没找到「做了跟没做一样」的常见场景。

**写下代价，不留白**：v1 之后模型仍然不能自己起 dev server。想跑长命令还是 Bash + 600s 上限。
这是明知的缺口，编号为**步骤 5b**。

## 4. 工具表面

一个工具：`RunOutput`。`readOnly: true`、`parallelizable: true`。

```jsonc
{
  "runId": "string?",                       // 省略 = 列出本会话的所有 run
  "since": "number | {out?, err?} | null",  // 见 §5
  "stream": "'out' | 'err' | 'both'?"       // 缺省 both
}
```

### 4.1 **不标** `sessionScoped` —— 这条必须显式写

同一张清单里的三个邻居**全都标了**：

```
$ grep -n "sessionScoped" packages/tools/src/{agent-tool,todo,schedule-wakeup}.ts packages/core/src/workflow.ts
packages/tools/src/agent-tool.ts:42:    sessionScoped: true,
packages/tools/src/todo.ts:32:    sessionScoped: true,
packages/tools/src/schedule-wakeup.ts:14:    sessionScoped: true,
packages/tools/src/agent-tool.ts:281:    if (tool.sessionScoped) continue
packages/core/src/workflow.ts:196:        if (tool.sessionScoped) continue
```

照着 §7 挂进 `SESSION_CAPABILITY_TOOLS` 的人，看到邻居全标了，**反射性跟着标的概率很高**。

**`RunOutput` 不该标。** `Tool.sessionScoped` 的定义是「它的**副作用**落在创建它的那个会话上」，
而 `RunOutput` 只读、无副作用；它绑父会话 sessionId 是**过滤依据**不是副作用；
§6 要防的是**跨会话**，子代理与父会话在同一信任域内。更要紧的是：
**「派个子代理去查这个失败」正是最有价值的用法**，标了等于从最主要的消费者手上拿走。

标错的症状是「子代理莫名其妙看不到 run」——`tool.ts` 的注释自己形容的「最难查的那一类」。
所以 §10 有一条**反向**变异测试守着。

### 4.2 不给 runId：列清单

```
本会话有 3 个运行：

  #a3f21c8b  已结束 exit=1   (12 秒前)   pnpm test
  #7d0e94f2  运行中           (3 分钟前)  pnpm dev
  #c14b0a37  已结束 exit=1   (5 分钟前)  用 uv 跑 Python

用 RunOutput({runId: "a3f21c8b"}) 读某一个的输出。
```

id 用**前 8 位**。`randomUUID()` 完整值 36 字符，几个 run 就是上百字符纯噪声。
**服务端按前缀匹配，撞了就报「前缀不唯一」让模型给更长的**，绝不随便挑一个。

**显示名分两档**（§2.9）：

- 项目档：`command` 原样、**不截断** —— 截掉尾巴等于把 `pnpm test packages/core` 和
  `pnpm test packages/web` 变成同一条。
- 片段档：命令是 `uv run --no-project "C:/…/Temp/zuse-run-XXXXXX/main.py"`，
  **三次运行只差一段随机后缀，看了等于没看**。用 `planExec` 的 `label`（「用 uv 跑 Python」）。

所以 `StartRunInit` / `RunSummary` 要加一个可选 `label`；`runsRoutes.ts` 起片段 run 时把
`plan.label` 传进去。清单优先显示 `label`，没有就显示 `command`。

### 4.3 给了 runId：读输出

```
运行 #a3f21c8b — pnpm test
状态：已结束，退出码 1（进程正常退出）
stdout 共 40000 字符，本次 [0, 24000)；stderr 共 8213 字符，本次 [0, 8213)

--- stdout ---
…

--- stderr ---
…

stdout 还有 16000 字符未读。继续：RunOutput({runId:"a3f21c8b", since:{out:24000, err:8213}})
```

## 5. 游标

轮询是主要用法（模型起了个构建，隔一会看一眼），全量回读意味着第二次把读过的又灌一遍上下文。
所以必须增量。**模型传偏移量，服务端不记状态** —— 服务端记的话模型就再也回不去重读，
而「回头确认一下刚才那行报错」是真实需求。

### 5.1 坐标系：`[firstChar, firstChar + snapshot.length)`

v1 写的是 `dropped = totalChars - snapshot().length`，**这个公式只对 ring 成立**（§2.4）。
按它在片段档下推演（budget=200_000，实际产生 250_000）：

- 算出 `dropped = 50_000`；模型传 `since: 0` → spec 要求「明说 [0, 50000) 已被丢弃」。
  **这是假话** —— 这 5 万字恰恰是唯一保住的开头。
- 内容从 `snapshot()[0]` 起给、被标成绝对位置 50000，后续索引 `since - dropped`
  **恰好还是连续的**。于是任何「读到的内容对不对」的测试**全绿**。
- 模型一路读到 `since = 250000 = totalChars` → 「暂无新输出」→ **模型认为自己读完了 25 万字**。
  实际它只看到 [0, 200000)，真正丢掉的最后 5 万字一个字都没提。

而那 5 万字正是最要紧的：`run.ts` 里 `if (sink.overflowed && !wasOver) this.kill('output-cap')` ——
输出爆掉被杀，就是用户来问「它怎么了」的时刻。

**修法：不按 sink 种类分支，给 `OutputSink` 加一个 `firstChar`。**

| | `firstChar` | 含义 |
|---|---|---|
| `RingSink` | `total - buf.length` | 丢的是**前缀** |
| `TruncateSink` | 恒 `0` | 丢的是**后缀** |

于是持有区间统一为 `[firstChar, firstChar + snapshot().length)`，两个缺口各自可判：

- `firstChar > 0` → 前面缺了 `[0, firstChar)`
- `firstChar + snapshot().length < totalChars` → 后面缺了

**尾部缺口的判据只能是那个算术式，`endReason` 绝不能当条件。**
初稿写的是「这一档必然伴随 `endReason === 'output-cap'`」——**这句是假的**：

```
$ sed -n '180,181p' packages/tools/src/run/run.ts
  kill(reason: EndReason): void {
    if (this.ended || this._status !== 'running') return
$ grep -n "this.kill('wall-clock')\|this.kill('detach')\|this.kill('idle')\|this.kill('output-cap')" packages/tools/src/run/run.ts
132:      this.wallTimer = setTimeout(() => this.kill('wall-clock'), init.policy.wallClockMs)
172:      if (this.subs.size === 0 && this.policy.onDetach === 'kill' && !this.ended) this.kill('detach')
237:    if (sink.overflowed && !wasOver) this.kill('output-cap')
243:    this.idleTimer = setTimeout(() => this.kill('idle'), this.policy.idleMs)
```

`kill()` 对**已经在 `killing`** 的 run 是 no-op，`pendingReason` 保持先前那个。
可达序列（片段档，`onDetach:'kill'` + 3 秒宽限）：用户关页面 → 172 行 `kill('detach')` →
`_status='killing'` → 宽限期内 `onText` 照跑、sink 照收 → 撑爆预算 → 237 行
`kill('output-cap')` **撞上第 181 行直接返回**。最终 `endReason === 'detach'`。

把提示挂在 `endReason` 上的后果：detach / wall-clock / idle 抢跑时模型**拿不到尾部缺口提示**，
就是本节要消灭的那个「模型以为自己读完了」的 bug 换扇门原样复活 —— 而 §10.2 的变异测试
（测的是干净的超预算场景）**是绿的**。这正是初稿那个 bug 的特征。

`endReason` 只作为附加说明打印（多数情况确实是 `output-cap`），不参与判定。

**按 sink 种类 `if/else` 是错的做法**：那会让「工具层知道策略层的实现」，
而 `policy.ts` 的文件头明写这个类型「**不许长出 `kind: 'snippet' | 'project'` 这种判别字段**」。
`firstChar` 是 sink 自己的性质，加在 `OutputSink` 接口上，将来第三种 sink 自动正确。

判定表（单条流）：

| 情形 | 行为 |
|---|---|
| `since >= totalChars` | 「暂无新输出」（**不是空字符串**） |
| `since >= firstChar` | 从 `snapshot()[since - firstChar]` 起给 |
| `since < firstChar` | **明说** `[since, firstChar)` 已丢弃，从 `firstChar` 起给 |
| 右端 `firstChar + snapshot().length < totalChars` | **明说**尾部 N 字符已丢弃（附带打印 `endReason`，但不拿它当条件） |

第三、四行的「明说」是重点。**静默地跳过，模型会以为读到的是连续的输出**，
然后对着一段中间（或尾部）缺了几万字符的日志做推断。宁可让它知道自己漏了。

### 5.2 游标必须**每条流各一个**

两条流是**各自独立**的 sink：

```
$ grep -n "this.sinks = " packages/tools/src/run/run.ts
116:    this.sinks = { out: makeSink(init.policy), err: makeSink(init.policy) }
```

`policy.ts` 的 `sink` 字段注释原文：「预算是**每条流各自**的，不是两条流共享」。
所以 `out.totalChars` 与 `err.totalChars` 是两个独立计数器。

**v1 的单个标量 `since` 在 `both` 档下会让 stderr 永久读不到。** 按 §4.3 的数量级推演
（out=40000，err=8213，单次上限 30000）：

1. `since: 0` → 从 out 给满 30000，尾部提示 `since: 30000`
2. `since: 30000` → 对 out 给 [30000,40000)；对 err，`30000 >= 8213` 落第一行 →「暂无新输出」
3. **stderr 那 8213 字符一个字都到不了模型**

而 §1 说的痛点就是「用户跑出一个 traceback」——**traceback 走 stderr**。
Python `uv run` 的异常、`planExec` 注释里明写的 Java 编译错误全在这条流上。

**修法**：

- 入参 `since` 接受 `number` **或** `{out?, err?}`。给数字 = 两条流各自用这个偏移
  （对 `0` 和负数天然正确，这也是 90% 的用法）；给对象 = 逐流精确。
- 返回体**永远**给 `nextSince: {out, err}`，提示语让模型原样传回。

### 5.3 负数 `since` = 从末尾往前数

`since: -5000` = 每条流的最后 5000 字符。这是模型 90% 的实际需求（「看看它报了什么错」），
正数游标服务于「从头顺着读」。两种语义放同一个字段，靠符号区分 —— 它们是同一件事
（起点）的两种指定方式。超过总长（`-999999`）归一到 0，不报错。

### 5.4 单次上限与两条流的分配

**单次总上限 30_000 字符**，连续一段，不做 Bash 那种 head/tail 两段式 ——
两段式在有游标的场景下反而有害：中间挖掉一块之后 `since` 该给什么值就说不清了。

`both` 档下的分配（CAP = 30_000）：

```
wantOut = min(可给的 out 长度, CAP);  wantErr = min(可给的 err 长度, CAP)
若 wantOut + wantErr <= CAP        → 两条都给全
否则若 wantErr <= CAP/2            → err 给全，out 拿剩下的
否则若 wantOut <= CAP/2            → out 给全，err 拿剩下的
否则                                → 各 CAP/2
```

即**小的那条永远给全，大的那条吃剩余额度**，两条都大时对半分。
理由：stderr 通常很短而信息密度最高，让它被 stdout 挤掉是最坏的结果。

**代价**：一个 400k 字符的 dev server 日志要读十几次才能读完。**这是刻意的** ——
真需要全量读 400k 日志的场景不存在，模型要的是「最后那段报错」，那是 §5.3 一次调用的事。

### 5.5 切片边界不能把转义序列切成两半

30_000 的切点会正好落在 `\x1b[31m` 中间 —— `termText.ts` 的注释就是为这件事写的
（「否则 `\x1b[3` | `1m` 会漏进正文」）。**新写一份朴素的 `replace` 必然漏掉这个。**

**游标是原始（未净化）坐标系** —— 先按原始 offset 切片，再净化。所以：

**规则 (a) 右边界收回**：取原始区间 `[a, b)` 后，若有一段 CSI 从 `s < b` 起、到 `b` 还没结束 →
**把 `b` 收回到 `s`**，`nextSince` 报收回后的值，下一段正好从序列开头接上。

**规则 (b) 退化时前伸**：若收回会导致 `b == a`（这一段整个就是一条超长序列的开头）→
反向**前伸**到**序列结束、或可给区间末尾，取先到者**，否则游标永远不前进。
「或可给区间末尾」不能漏：**进程可以死在半截序列上**（sink 里最后三个字符就是 `\x1b[3`，
之后再也不会有输出）。写成「前伸到序列结束」而序列没有结束时，`nextSince` 永远停在原地、
尾部提示永远说「还有 3 字符未读」，**模型对着一个已经 `exited` 的 run 无限轮询**。
补充：`status === 'exited'` 时末尾挂着的半截序列**直接消费掉并丢弃**，
`nextSince` 推进到 `totalChars`。仓库里已有同样的判断 —— `termText.ts` 的 `flush()` 注释：
「悬挂的 `\r` 直接丢弃（它后面永远不会有东西了），半截转义序列也丢弃（那不是给人看的）
——但**正文必须留着**」。

**规则 (c) 起点归位：往回看，不要猜。** 起点 `a` 由归纳法保证在边界上（我们只发出安全的
`nextSince`），但模型可以传任意负数，归纳链就断了。

> 初稿写的是「切片开头若挂着一截**孤儿序列尾巴**，直接剥掉」。**这条会大面积误删正文。**
> 孤儿尾巴从切片本身**不可识别** —— `termText.ts` 之所以永不认错，是因为它从头顺着流走、
> 用 `pendingEsc` 把状态带过来，它**知道**前面有没有 `\x1b[`；而本工具是无状态的（§5 的刻意
> 取舍），`31m` 和 `main` 在它眼里长得一模一样。唯一能写的判据是把 `ANSI_FULL` 去掉被切走的
> `\x1b[` 前缀，得到 `^[0-9;?]*[ -/]*[@-~]`。实测（`scratchpad/probe-orphan.mjs`）：
>
> ```
> EATS "31m"      <- "31mRED"                            =>  "RED"          ← 唯一一条是对的
> EATS "T"        <- "Traceback (most recent call last):" =>  "raceback …"
> EATS "E"        <- "ERROR: build failed"                =>  "RROR: …"
> EATS "m"        <- "main.py\", line 7"                  =>  "ain.py\", …"
> EATS "  a"      <- "  at Object.<anonymous>"            =>  "t Object.…"
> keeps           <- "2026-08-13 10:27 build ok"
>
> 6/7 被吃掉（其中只有第 1 条是该吃的）
> ```
>
> 原因很直白：`[@-~]` 是 0x40–0x7E，**囊括全部大小写字母**，而前两个组都允许匹配空 ——
> 只要切片第一个字符是字母就被吃。而 §5.3 说负数 `since` 是「模型 90% 的实际需求」，
> 落点是任意字符。于是绝大多数 `since: -5000` 的读取，第一个字符被无声吃掉，
> `Traceback` 变成 `raceback` —— 少一个字母，review 时几乎看不出来，
> 而模型会对着被篡改的第一行做推断。

**正确做法**：`snapshot()` 整个字符串就在手里，`a` 在其中的下标是 `a - firstChar`。
从该下标**向前扫一个有界距离**（CSI 很短，64 字符封顶）找 `\x1b`；找到、且它开的序列跨过了
`a`，就把 **`a` 前推到序列结束**，并在「本次读取 [a, b)」里报前推后的 `a`。
找不到 `\x1b` 就说明 `a` 本来就在边界上，什么都不做。这与规则 (a) 收回右边界是同一个操作的
镜像：**确定性、零误删、不需要「孤儿尾巴」这个概念。**

另外要向模型说明：「本次 [a, b)」是**原始**区间，净化后字符数会少于 `b - a`，这是正常的。

### 5.6 已知代价：分段净化 ≠ 整份净化

**`\r`「覆盖本行」的作用域是整行，跨读取边界时前一段的残行抹不掉。**
用**真的** `TermBuffer` 实测（`scratchpad/probe-seg.mts`，`node --experimental-strip-types`
直接 import `packages/web/src/exec/termText.ts`）：

```
"aaaa\rbbbb"       cut@4 | whole="bbbb"     | seg1+seg2="aaaabbbb"   *** DIFFERENT ***
"10%\r20%\r100%"   cut@4 | whole="100%"     | seg1+seg2="10%100%"    *** DIFFERENT ***
"done\nA\rB"       cut@6 | whole="done\nB"  | seg1+seg2="done\nAB"   *** DIFFERENT ***
"a\r\nb"           cut@2 | whole="a\nb"     | seg1+seg2="a\nb"         SAME
"x\x1b[31mRED"     cut@4 | whole="xRED"     | seg1+seg2="x1mRED"     *** DIFFERENT ***

4/5 组分段净化 != 整份净化
```

根因是 `overwriteLine()` 抹的是**累计文本**里最后一个 `\n` 之后的内容 —— 落在段 2 开头的 `\r`，
要抹的字符长在**段 1 的尾巴上**。这是个负增量，跨段表达不了；而本工具每次调用独立、无状态。
（第 4 行 `\r\n` 跨段之所以 SAME，是 `pendingCR` 那条路径碰巧对上了，不能推广。
第 5 行 DIFFERENT 反而是好消息：它证明 §5.5 规则 (a) 的收回是必需的。）

**代价：模型轮询一个带进度条的构建时，每个读取边界会残留一行过期的进度条。**
**不修** —— 修它要么让工具有状态（违反 §5「服务端不记状态」这条核心取舍，模型就再也回不去
重读了），要么每次重新净化整份（O(n²)）。写下来，不留白。

这条直接决定了 §10 的测试怎么写：**不许**断言「两段拼起来 == 整份净化的结果」，那条按字面写
必然红；而实现者为了让它绿，会挑一份不含 `\r` 的夹具 —— 于是它退化成「测了个不会失败的东西」，
正是本仓最该防的那类假绿。拆成两条，见 §10.6a/6b。

## 6. 会话隔离

**模型只能看到自己会话的 run。** 这不是可选的加固 —— 步骤 4 刚补过一轮同类的洞
（`4cd3c46 fix(server): run 端点的会话隔离（评审 M3/M6，都是已合入代码的洞）`），
HTTP 层三个路由都补了，工具层是**第四个入口**，漏了等于前面白补。

`RunSummary` 带 `sessionId`，按它过滤。给了 runId 但不属于本会话 →
**报「没有这个运行」，不报「无权访问」**：后者会把「别的会话存在一个 id 为 X 的 run」这个事实
泄露给模型，而模型的输出会进用户的聊天记录。

被 `maxFinished`（默认 20）淘汰掉的 run 落同一句「没有这个运行」，语义无歧义，不额外处理。

## 7. 接线

选 `SESSION_CAPABILITY_TOOLS`（§2.7：另一条接缝拿不到 sessionId）。

1. `SessionCapabilityContext` 加 `sessionId: string`、`runs?: RunRegistry`
   （可选 —— TUI 那条路径没有 run 注册表，`enabled` 判据缺省不注册）
2. `SessionManager` 构造 `capabilityCtx` 时**逐字段**填（那张清单的注释写明了 spread
   会绕过 TS 的多余属性检查、让改名静默变 undefined）
3. `SessionService` / `createSession` 把 `runs` 透传下去
4. `startServer.ts` 把 `new RunRegistry` 从 220 行上移到 `new SessionService` 之前
   （§2.7 复核过：无依赖顺序风险）

`RunOutput` 放 `packages/tools/src/run/outputTool.ts` —— 与 `RunRegistry` 同包，不加跨包依赖。

## 8. 模型怎么知道该去看

**这是本设计最可能失败的地方。** 工具存在 ≠ 模型会用。真实时序是：用户点运行 → 失败 →
用户打字「修一下」→ 模型此时**必须自己想到**去调 `RunOutput`。想不到，功能等于没做。

**(a) 工具 description 里写明引导** —— 零改动，但不可靠。

**(b) 提交消息时注入一行现状** —— 经 `expandAttachments` 的**请求专用副本**（§2.8），
往最后一条 user 消息追加一小块：每个 run 一行（id / 显示名 / 状态 / 退出码，**不含输出**），
只列 **在跑的** 和 **非零退出的**，最多 3 条。正常跑完（exit=0）的不提 —— 没什么要修的，
提了只是噪声。

**(a) + (b) 都做。** 且 **(b) 绝不能走 `applyUserStamp`**：§2.8 列了那条路的 4 个消费者，
拼进去的话用户气泡里会出现自己没打过的字、**会话标题会变成 run 状态**、点 retry 会把这段
状态当用户原话重发并反复叠加。`expandAttachments` 那条是请求专用副本，不进账本、不进标题、
不进搜索、不被 retry 重发，且每回合按当时状态重算（旧回合不会留下过期的「运行中」）。

> v1 这里写着「如果没有干净接缝就先只做 (a)」。**这句已删** —— 接缝存在且已定位（§2.8），
> 留着它，实现者最省事的路径就是跳过 (b)，而 §10.9 又把发现机制列为最可能失败的地方。
> 自己给自己开后门。

**已知缺口（写下来，不留白）**：`steer()` 不过 submit —— 回合内插话经 `consumeSteer` 把裸文本
折进 tool_result，**不带这行提示**。用户「点运行 → 失败 → 趁模型还在跑时插一句『修一下』」
走的正是这条路。v1 接受这个缺口（(a) 的 description 仍在，模型仍可能主动查），
记为欠账；要补就在 `consumeSteer` 那侧再接一次。

## 9. 明确不做

| 不做 | 为什么 | 什么时候做 |
|---|---|---|
| 模型起后台 run | §3，要先给权限层去名字化 | 步骤 5b |
| 模型停 run | **不是**因为「起都不能起」（`stop(runId)` 不接命令、根本不碰 §2.1 那个闸）。真理由：它不再只读，会破坏 `readOnly: true`；而且「模型停掉用户正盯着的 dev server」是真实的意外行为 | 跟 5b 一起，届时单独论证 |
| 给模型 SSE / 推送 | 模型只在用户发消息时才动，推送没有接收方 | 不做 |
| ANSI→颜色（上色） | 那是**渲染**侧的欠账，方向与本步相反 | 独立排期 |
| 输出落盘 | `sink.ts` 明说本模块不落盘；游标 + 有界缓冲已经够 | 有人真被上限咬到再说 |

**净化（剥 ANSI + 折 `\r`）不在「不做」里，是本步必做的**，见 §2.5/§2.6：
`termText.ts` 的 `TermBuffer` 已经把这两件事做对了，把其中的纯变换下沉到
`@zuse/protocol`，web 侧的增量 buffer 与工具侧的一次性切片**共用同一份规则**。
`RunOutput` 剥，右栏也剥 —— 两侧一致，不是相反。

## 10. 测试要点

带 **[变异]** 的必须做变异验证：改坏实现 → 确认测试真的红 → 精确改回。

1. **[变异]** 会话隔离：A 会话的工具读 B 会话的 runId → 报「没有这个运行」。
   变异：去掉 sessionId 过滤 → 必须红。
2. **[变异]** **truncate 档缺的是尾巴**：超预算的片段 run，读到底之后输出里**必须**出现
   「末尾…已丢弃」，且**不得**出现「开头…已丢弃」。
   变异：把 `TruncateSink.firstChar` 改成 `total - buf.length` → 必须红。
   （这条守的就是 §5.1 那个 v1 错误。**已做**，见 `sink.test.ts` 的 `firstChar` 一组。）
2b. **[变异]** **尾部缺口不许挂在 `endReason` 上**：先 `kill('detach')`（run 进入 `killing`）
   **再**撑爆 sink，最终 `endReason === 'detach'` 而非 `'output-cap'` —— 尾部缺口提示
   **仍必须出现**。变异：把判据改成 `endReason === 'output-cap'` → 必须红。
   （§5.1 实测过 `kill()` 第 181 行的 early return；不加这条，2 号测试是绿的而 bug 已复活。）
3. **[变异]** ring 档缺的是前缀：丢了前 100 字符、`since: 50` → 必须出现「已丢弃」且内容从
   第 100 字符起。变异：静默从 100 起给 → 必须红。
4. **[变异]** `RunOutput` **在**子代理的注册表里。变异：加上 `sessionScoped: true` → 必须红。
   （§4.1：这条是**反向**的 —— 防的是有人照着邻居顺手标上。）
5. **`both` 档下 stderr 读得到**：out 远长于 err，一次调用后 err 的内容必须出现在结果里。
   这条直接守 §5.2 那个 v1 错误。
6a. **游标严丝合缝（在 `both` 档，断言落在原始坐标上）**：把返回的 `{out, err}` 原样传回，
   各流的原始区间**首尾相接、无重叠无空洞**，最终覆盖到 `[firstChar, firstChar+len)` 的右端。
   这条守的是 §5.2 那个洞，**与净化无关**。
6b. **净化是纯函数单测**（整份输入 → 整份输出，覆盖 ANSI / `\r` / CRLF），
   就是现有 `termText.test.ts` 那套，跟着下沉一起走。
   **绝不许写成「两段拼起来 == 整份净化」** —— §5.6 实测 4/5 组不成立；按字面写必然红，
   而为了让它绿去挑一份不含 `\r` 的夹具，就退化成假绿。
7. 切片切断转义序列：构造一条 CSI 正好跨 CAP 边界的输出 → 结果里无 ESC 残片，且下一段接得上。
   再构造「整段就是一条超长序列开头」的退化情形 → 游标必须前进，不能卡死。
   **再加一条**：run 已 `exited`、末尾是**永远不会结束**的半截 CSI → `nextSince` 必须推进到
   `totalChars`，第二次调用得到「暂无新输出」（§5.5 规则 (b)；写成「前伸到序列结束」会无限轮询）。
7b. **起点归位不许误删正文**：`since` 为负数、落点是字母（`Traceback…` / `ERROR:` / `  at `）
   → 输出**一个字符都不许少**。这条直接守 §5.5 规则 (c) 那个「6/7 被吃掉」的错误做法。
   **CAP 必须可注入**，否则这几条要造 3 万字符的夹具。
8. 裸 `\r` 折叠：几百次重绘的进度条 → 结果只剩最后一版。
9. 边界：`since == firstChar`；`totalChars == 0`；`-999999`；ring 从没丢过字符；
   单次 push 就超过整个容量（`sink.ts` 有这个分支）。
10. runId 前缀撞了 → 报「前缀不唯一」，**不能随便挑一个**。
11. 不给 runId → 列清单；本会话零个 run → 明确说「本会话还没有运行过命令」，不是空清单。
12. 片段档清单显示 `label`（「用 uv 跑 Python」），不是那条带随机临时目录的 `uv run …`。
13. **真跑验证（测试绿 ≠ 能用）**：真浏览器点「▶ 运行 → 一个会失败的脚本」，
    然后在聊天框问「刚才那个跑挂了，为什么」，**看模型是否真的调用了 `RunOutput`
    并读到了报错**。这条不能用单测代替 —— 它验的是 §8 的发现机制，
    而那是本设计最可能失败的地方。

## 11. 落地顺序

1a. **先补测试再动 `termText.ts`。** 现有 9 条 `feed([...])` 用例**全部避开**了「裸 `\r` 落在
   **后一块开头**、要抹掉前一块已定稿内容」这条路径（最接近的 `feed(['aaa\r','b'])` 是 `\r` 在
   前一块结尾，走 `pendingCR` 分支，完全不同的代码）。补上
   `feed(['aaa','\rb']) === 'b'` 和 `feed(['done\nA','\rB']) === 'done\nB'`。单独提交。

   **为什么这一步不能跳**：第 1b 步「复用一份纯函数」最省事的写法就是「每块自己净化再拼接」
   —— 而 §5.6 实测那正是错的。做了之后 `['aaa','\rb']` 会变成 `'aaab'`，
   **现有 9 条用例一条都不会红**，右栏进度条从此不折叠，没人会发现。
1b. **净化下沉**到 `@zuse/protocol`。**下沉的必须是有状态的 `TermBuffer` 本体**，
   一次性切片版只能是它之上的薄封装（`new TermBuffer().push(s)` + `flush()`）——
   **不能反过来拿一次性版拼出增量版**，那会丢掉 `pendingCR`/`pendingEsc`。
   `termText.ts` 改为复用，行为不变（1a 补完的测试必须全绿）。
2. **`OutputSink` 加 `firstChar`**（✅ 已完成，commit `e36e1f7`，含变异验证）
   + `Run` 加带 `firstChar`/`totalChars`/**每流各自**计数的读取口。
3. **`StartRunInit`/`RunSummary` 加 `label`**，`runsRoutes.ts` 传 `plan.label`。
4. **`RunOutput` 工具本体** + 单测（§10 的 1–12）。
5. **接线**：能力面加字段 + `startServer` 上移 `new RunRegistry`。
6. **§8(b) 的注入**（`expandAttachments` 那条，不是 `applyUserStamp`）。
7. 真跑验证（§10.13），合本地 master，写 `docs/features.md`。

## 12. 修订记录（v1 → v2）

独立评审 7 条，全部属实、全部已改。我逐条用命令自证过原文才动手。

| # | 评审指出 | 改动 |
|---|---|---|
| 1 | `dropped` 公式在 truncate 档语义相反，会把「尾部丢了」报成「开头丢了」，且**测试全绿** | §2.4 + §5.1 重写：改用 `firstChar` 抽象，两个方向的缺口各自明说；§10.2 变异测试 |
| 2 | 单标量 `since` 在 `both` 档下让 **stderr 永久读不到**（traceback 就在那） | §5.2 每流各一个游标；§5.4 分配规则；§10.5/§10.6 守 |
| 3 | 「右栏不剥 ANSI」前提是错的（`termText.ts` 早就在剥），且 spec 通篇没提裸 `\r` | §2.5/§2.6/§9 重写：下沉到 `@zuse/protocol` 共用；§5.5 切片边界；§10.7/§10.8 |
| 4 | §8(b) 的接缝**存在**（`expandAttachments`），而 `applyUserStamp` 那条有 4 个消费者会漏；「找不到接缝就跳过」是给自己开后门 | §2.8 + §8 重写，删掉那句退路；补 `steer()` 缺口 |
| 5 | 片段档三次运行 `command` 只差随机后缀，`label` 没存 | §2.9 + §4.2 分两档；§11 第 3 步 |
| 6 | `sessionScoped` 只字未提，而同数组三个邻居全标了 | §4.1 显式写「不标」+ 理由；§10.4 **反向**变异测试 |
| 7 | 「起都不能起，停谁？」这条论证一推就倒 | §9 换成真理由（破坏 `readOnly`、停掉用户正盯着的 dev server） |

评审同时复核确认**没问题**的：§3 的只读取舍（反向验证过「模型可以自己用 Bash 复现」）、
§5 单流坐标系的各个边界（无差一）、`startServer` 上移无依赖顺序风险、
`maxFinished` 淘汰后语义无歧义、返回体 token 成本可接受。

**评审顺带发现的、与本步无关的洞**（另记欠账）：`RunRegistry.killSession` 全仓只有定义、
**没有生产调用方** —— 删会话不杀 run，会留下孤儿进程。

## 13. 修订记录（v2 → v3）

二轮评审只审「我自己发明的修法」。5 个点里 2 个复核无问题（`firstChar` 抽象本身、
§5.4 的额度分配 —— 它跑了 16 组数据，含我点名的两条边界），**3 个有真洞，且都跑出了反例**。
我用命令逐条复现过才动手。

| # | 二轮指出 | 改动 |
|---|---|---|
| 1 | §5.1「尾部缺口**必然伴随** `output-cap`」**是假的**：`kill()` 对已在 `killing` 的 run 是 no-op（`run.ts:181`），detach/wall-clock/idle 会抢跑。照这句写，v1 那个 bug 换扇门复活，**而 §10.2 是绿的** | §5.1 改成「判据只看算术式，`endReason` 只作附注」；§10 加 **2b**（先 detach 再撑爆 sink） |
| 2 | §5.1 表格「**且是 truncate 档**」自相矛盾（三行前刚禁止按种类分支），而且多余 —— ring 档下该条件恒 false，算术自己就分开了 | 删掉那四个字 |
| 3 | §5.5「剥掉孤儿序列尾巴」**6/7 条正文被吃**（`Traceback`→`raceback`）：`[@-~]` 囊括全部字母，而负数 `since` 落点是任意字符 | 改成「往回看、前推 `a`」（规则 (c)），与规则 (a) 对称 |
| 4 | §5.5 规则 (b)「前伸到序列结束」在**序列永远不结束**时未定义 → 已 `exited` 的 run 无限轮询 | 补「或可给区间末尾，取先到者」+ `exited` 时丢弃半截序列；§10.7 加这条 |
| 5 | §10.6「两段拼起来 == 整份净化」**不成立**，真 `TermBuffer` 跑出 4/5 组反例（`\r` 的作用域是整行，跨段抹不掉） | 新增 §5.6 写下这个代价；§10.6 拆成 **6a**（原始坐标的游标测试）+ **6b**（整份净化纯函数单测） |
| 6 | §11 第 1 步「行为不变」有测试守，但**恰好漏了重构最可能撞坏的那条**：现有 9 条用例全部避开「裸 `\r` 落在后一块开头」 | §11 拆成 **1a**（先补那两条测试）/ **1b**（下沉必须是有状态的 `TermBuffer` 本体） |

两个探针脚本留在
`C:\Users\nhn\AppData\Local\Temp\…\scratchpad\{probe-orphan.mjs, probe-seg.mts}`，
`probe-seg.mts` 直接 import 真的 `termText.ts`（`node --experimental-strip-types`），
不是我另写一份 —— 另写一份只能验证我的理解，验证不了实现。
