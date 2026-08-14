# daemon 死掉之后不留孤儿进程（回溯审计 F P2）设计 v2

日期：2026-08-14
状态：v2 —— **独立评审否决了 v1 的主方案**；本版按评审结论拆成两步，只做第一步

## 〇、v1 被否决的经过（留档，别再走一遍）

v1 的方案是「PowerShell 看门狗持 Job Object + `KILL_ON_JOB_CLOSE`」。我实测它在目标场景下
**有效**（daemon 被 `taskkill /F` 硬杀后孙进程被 OS 收掉，心跳停在 t=14）。评审复跑了 8 组
对照，推翻了三条：

1. **v1 决策表里 A 相对 B 的唯一硬优势不存在**。表里写「`taskkill /T` 同时杀掉 daemon 和
   看门狗时 B 会留孤儿」—— 实测 `/T` 自己就把整棵三层树收干净了，那一格 B 根本没有孤儿可留。
2. **`KILL_ON_JOB_CLOSE` 的触发条件我没搞懂**。评审实测：单独 `taskkill /F` 杀看门狗
   （句柄关闭）**什么都没死**；让看门狗正常退出（stdin EOF）**也什么都没死**；
   先杀看门狗、10 秒后再杀 daemon，孙进程**这时才**死。三个结果与「关句柄即收割」的模型
   互不相容。而且所有测量都是在「daemon 已经在别人的 job 里」（终端/harness 建的外层 job）
   这一种环境下做的，走的是**嵌套 job** 语义 —— v1 §1.2 那句「实测有效」一个字都没提这个前提。
3. **v1 §1.3 第 1 条的解释是错的**（我事后合理化，没验证）。v1 说「手填 144 报
   ERROR_BAD_LENGTH，`Marshal.SizeOf` 算出来也是 144，所以错的是内存布局」。
   评审直接测了那条路：手填 144 **成功**（`ok=True err=0`），缓冲区全填 0xAB **也成功**，
   只有长度传 112 才报 24。内核对这个 info class 只校验长度，不看内容。
   真实原因只可能是 v1 那次传的长度根本不是 144，或 P/Invoke 漏了 `SetLastError=true`
   导致读到陈旧错误码。**结论（用 `Marshal.SizeOf`）对，理由错** —— 按本仓约定，
   写错的「为什么」比不写更有害。

评审的明确结论：**A 不该做** —— 不是因为贵，是因为它把一个**尚未被理解的内核行为**放在了
「能一次性带走整个 daemon」的位置上，而它宣称的收益在实测里并不存在。

## 一、拆成两步

### 第一步（本轮做）：进程级退出兜底

**这是今天完全没有覆盖的路径，而且修它约等于免费。** 仓库自己在三处写下了这个空缺：

```
packages/core/src/kill-tree.ts:30:    // **没有任何 catch**，本仓也没有 process 级 uncaughtException 兜底。
packages/server/src/http/server.ts:287:    // (本仓没有注册 process 级的 unhandledRejection 处理)。
packages/tools/src/run/run.ts:385:   * 这条栈上**没有任何 catch**，而本仓没有 process 级 uncaughtException 兜底
```

而 `bin.ts` 只挂了两个信号：

```
packages/server/src/bin.ts:108:  process.on('SIGINT', shutdown)
packages/server/src/bin.ts:109:  process.on('SIGTERM', shutdown)
```

run.ts:380 那段注释记着一次**真跑复现过**的事故：一个 SSE 订阅者 throw 一次，
「整个 daemon（用户的所有会话）退出码 1 死掉」。那种死法下，在跑的子进程今天是零清理。

### 第二步（本轮**不做**，记账）：Job Object 看门狗（B 版）

评审给的形态是：不设 `KILL_ON_JOB_CLOSE`，看门狗用
`WaitForSingleObject(daemon 进程句柄, INFINITE)` 等 daemon 死（而不是等 stdin EOF ——
EOF 依赖管道写端引用计数归零，一个继承了写端副本的长命孙进程就能构成死锁），
醒来后显式 `TerminateJobObject`。

**不做的理由**：它换来的只剩「用户手动 `taskkill /F` 且**不带** `/T`」这一种死法，
而本仓 `.claude/skills/restart/SKILL.md:27` 已经带了 `/T`。代价却是常驻一个 PowerShell、
一套 Windows-only 的代码、以及一个「保护静默失效」的新失效模式。
**先把第一步做完、把 §〇 第 2 条那个机制搞清楚，再谈这笔交易。**

## 二、第一步的实测依据

**唯一需要拍板的问题是：兜底该挂在哪个事件上。** 评审建议挂
`uncaughtException` + `exit`。但挂 `uncaughtException` 会**改变进程语义**
（node 默认的「打印堆栈 + 退出」要自己重新实现，写漏一点就变成崩溃后不退出）。
所以先测：崩溃时 `'exit'` 到底跑不跑？

```
$ for m in throw reject sigterm normal; do node exitprobe.cjs $m out.txt; echo "$m 退出码=$?"; done
throw 退出码=1
reject 退出码=1
sigterm 退出码=1
normal 退出码=0

--- exit 处理器实际跑了哪些 ---
throw:  EXIT_HANDLER_RAN code=1     ← 未捕获异常，exit 照跑
reject: EXIT_HANDLER_RAN code=1     ← 未处理的 Promise rejection，exit 照跑
normal: EXIT_HANDLER_RAN code=0
（sigterm 没有这一行）
```

**结论：只挂 `process.on('exit')` 就覆盖了两条崩溃路径，且一点语义都不改。**
不需要 `uncaughtException`／`unhandledRejection` 处理器 —— 这比评审建议的更小、更安全。

`sigterm` 那一行没出现，是因为探针没注册 SIGTERM 处理器、走了 node 的默认终止。
`bin.ts:108-109` 两个信号都注册了、且走 `process.exit(0)`，所以 `'exit'` 会跑。
**`taskkill /F` 依然什么都不跑** —— 那正是第二步才能覆盖的残余，本版不假装覆盖它。

## 三、方案

新增 `packages/core/src/child-reaper.ts`：

```ts
export function trackChild(pid: number | undefined): void
export function untrackChild(pid: number | undefined): void
export function reapTrackedChildren(): number      // 对每个在册 pid 跑 killTreeSync，返回条数
export function armChildReaper(): void             // 幂等；注册 process.on('exit')
export function __trackedPidsForTest(): number[]
```

- 放 core 而不是 tools：`killTreeSync` 已经在 core（F P7 那轮从 tools 搬过去的，
  因为 core 的 `mcp-transport.ts` 够不着 tools）。
- **`trackChild` 里懒注册 `armChildReaper()`**（同 `LspManager.armCleanup()` 的先例）。
  这么做是安全的，因为**加一个 `'exit'` 监听器不改变进程怎么死** —— 而加
  `uncaughtException` 监听器会（那就必须显式调用，不能藏在库里）。

接线点：

| 位置 | 动作 |
|---|---|
| `packages/tools/src/proc/spawn.ts` `spawnShellCommand` | spawn 后 `trackChild(child.pid)`；`child.once('exit', …untrackChild)` |
| `packages/core/src/mcp-transport.ts` | 起 MCP server 进程后同样登记 / 注销 |
| `packages/tools/src/lsp/manager.ts` | **不动** —— F P7 已经给它挂了自己的 `exit` → `killTreeSync` |

### 3.1 为什么在 `'exit'`（而不是 `'close'`）注销

一旦 shell 进程退出，它的 pid 就可能被系统回收给别人。留在册子里，daemon 退出时
那一发 `taskkill /T /F` 就会**误杀无辜进程** —— 这正是 `bin.ts` 现有注释否决
「pid 落盘 + 启动时回收」的同一条理由。

代价说清楚：shell 已经退出、但它起的后台孙进程还活着时，我们**放弃**了那个孙进程。
这不是妥协，是**它本来就已经不可达** —— `bin.ts:99-101` 记着：
「父进程一死进程树就断了，事后补跑 `/T` 只会得到 `process not found`」。

### 3.2 本轮**不做**「启动时报告疑似孤儿」

评审建议顺带做这个。**不做，因为没有可靠的判据。** 要认出「上一次 zuse 留下的孤儿」
需要一个标记：pid 文件被 §〇 否决过（pid 会被回收）；环境变量在 `Win32_Process` 里读不到；
命令行里没有我们能加的标记。靠 `ParentProcessId` 指向死 pid 来猜，会把系统里正常的
守护进程一起报出来。**这需要它自己的一轮设计，硬塞进来只会得到一个会误报的功能。**

## 四、测试计划（TDD）

`packages/core/src/child-reaper.test.ts`：

1. `trackChild(undefined)` / `untrackChild(undefined)` 不抛、不入册。
2. 登记两个 pid → `__trackedPidsForTest()` 两个都在；注销一个 → 只剩一个。
3. 重复登记同一 pid 只算一条（Set 语义）。
4. `reapTrackedChildren()` 起**两个真的长跑子进程**，登记、收割，断言两个都真的死了
   （轮询 `process.kill(pid, 0)`），返回值为 2，且册子被清空。
5. `armChildReaper()` 幂等：调 10 次，`process.listenerCount('exit')` 只 +1。
6. **真子进程端到端**：起一个子进程，它自己 `trackChild` 一个孙进程后 `throw` ——
   断言孙进程被收掉。这条是唯一能证明「崩溃路径真的会清理」的测试，
   其余都只是在测记账。

`packages/tools/src/proc/spawn.test.ts` 增补：

7. `spawnShellCommand` 起的进程在**运行中**在册；退出后**不在册**。
   （变异：把 `'exit'` 改成 `'close'` → 用一个「退出后仍占着 stdout 的孙进程」的命令，
   断言它在 shell 退出后就已经注销 —— `'close'` 那版会晚注销，测试变红。）

**变异验证**：
- `reapTrackedChildren` 里的 `killTreeSync` 换成空操作 → 第 4、6 条必须红。
- `untrackChild` 改成空操作 → 第 2 条红。

**真跑验证**：起真 daemon → 用 run 服务跑一个长跑后台命令 → 让 daemon 走
**崩溃**路径（不是 SIGTERM）→ 数进程必须归零。**并且先做阴性对照**：
把兜底注释掉跑一遍，必须留下进程 —— 否则「归零」可能只是因为命令根本没起来。

## 五、代价与残余风险（说清楚，不夸大）

- 覆盖：未捕获异常、未处理 rejection、`process.exit()`、SIGINT/SIGTERM（bin.ts 有处理器）。
- **不覆盖**：`taskkill /F`（不带 `/T`）、断电、OOM killer。这些要第二步，本轮不做。
- 一个进程级 `'exit'` 监听器 + 一个 Set 的记账开销，可忽略。
- shell 退出后仍活着的后台孙进程放弃收割（§3.1，本来就不可达）。
