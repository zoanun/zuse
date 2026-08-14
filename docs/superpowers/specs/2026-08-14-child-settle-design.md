# 子进程收尾:从 `close` 改判 `exit`(回溯审计 F P1)

> v2 —— 按独立评审重写。v1 有**三处实质错误**:后果说轻了(不是等 120 秒,是**永不返回**)、
> 补救方案会**打死用户的后台进程**、以及给 run 的状态机开了一个新的 zombie 竞态。
> 逐条列在 §7,没有悄悄抹掉。

## 一、现象与实测

`bash.ts:223` 与 `run/run.ts:131` **都只监听 `'close'`**。`'close'` 的语义是
「进程已退出 **且** 所有 stdio 管道都关了」——后半句由**所有持有写端的进程**决定,
包括子进程 fork 出去、继承了同一个 stdout 管道的**孙进程**。

### 1.1 exit / close 的实测(本仓真实的 `spawnShellCommand`,git-bash)

```
echo                          exit@44   close@44   Δ=0ms  exit 后 0B
8MB 立刻退                     exit@139  close@139  Δ=0ms  exit 后 0B
8MB + 每块阻塞 30ms（慢消费）    exit@3781 close@3781 Δ=0ms  exit 后 0B
stdout+stderr 同时灌 + 慢消费    exit@2638 close@2638 Δ=0ms  exit 后 0B
stdin=pipe（不写不关）           exit@56   close@56   Δ=0ms  exit 后 0B
后台安静孙进程                   close 直到孙进程自己死才到     exit@68ms
后台吵孙进程                     *** 6s 无 close ***          exit@69ms，exit 后还在涨
```

**但机制不是「子进程写完才能退、node 一直在读」——v1 那句是错的。** 评审做了 v1 没做的一组:
**根本不读**(spawn 之后不挂 `data`)时,

```
pause 后：序为 exit@125 → data@125(1000B) → close@126     ← 100% 的输出在 exit 之后到达
一个 data 监听都没挂：exit@139 close@140，事后再挂监听收到 0B  ← 字节被 node 直接丢了
```

真实机制是:**node 在 emit `exit` 之后**才强制 `resume()` 各条 stdio 把它们冲干净。
所以 Δ=0 与「exit 后 0 字节」成立的**前提是消费者一直处在 flowing 模式**。
`bash.ts:198-199` 与 `run.ts:129-130` 都在 spawn 之后同步挂 `data`,今天满足这个前提
—— **结论可以用,但前提必须写下来**(见 §2.5)。

### 1.2 后果比 v1 写的重:不是「白等 120 秒」,是**永不返回**

`bash.ts` 的超时定时器(201-204)只置 `timedOut = true` + `killTree`,**它自己不 resolve**;
`finish()` **只**在 `close` 回调里被调用。孙进程扛过 taskkill → close 永不到 →
**promise 永远挂着**。评审真跑 `BashTool.run`:

```
①正常命令                          1082ms 返回 isError=false
②安静后台孙进程（活 3s，timeout=2s）  3186ms 返回（"超时"）—— 只是因为孙进程自己死了
③吵闹后台孙进程（活 30s，timeout=2s）  *** 15 秒硬闸到点仍未 resolve ***
```

伴随两个 v1 没记的后果:`StreamShaper` 的 spill 是**流式写盘**(`truncate.ts:164-194`,
fd 一直开着、每块 append),挂住期间那个文件**无上界地长**、还占一个 fd;
`ctx.signal` 的 abort 分支同样只 `killTree`,救不回来。

run 那侧:项目档 `wallClockMs: null` + `idleMs: null` + `onDetach:'keep'`
(`policy.ts:269-271`)→ run **永远停在 `running`**,永久占一个并发额度;
`maxConcurrent` 默认 8(`registry.ts:76`,`startServer.ts` 没传)→ 攒够 8 次 run 服务失效。

## 二、方案

### 2.1 `exit` 定生死,`close` 只是「顺便早到的确认」

新增 `proc/settle.ts`:

```ts
onChildSettled(child, { drainMs, onExit? }, cb) → { cancel() }
// cb 至多触发一次；cb 拿到 { code, signal, drained }
```

| 事件 | 动作 |
|---|---|
| `close` | 立刻收尾,`drained: true`(正常命令永远走这条,Δ=0ms) |
| `exit` | **先同步调 `onExit`**(见 §2.4),再起一个 `drainMs` 计时器;`close` 先到就取消 |
| 计时器到点 | 收尾,`drained: false`,并**停止收集**(见 §2.3) |

**`signal` 必须透传。** `bash.ts:251-253` 的 `code === null` 分支要打印 `[killed by signal: X]`,
X 来自 `close` 的第二个参数。helper 不透传就会打出 `undefined` ——
Windows 上不易发现(taskkill 走 exit code 1),**POSIX 上 SIGTERM/SIGKILL 天天走这条**。

**spawn 失败(ENOENT)时 `exit` 不触发、`close` 会带 `code: -4058` 触发**(实测),
所以 helper 必然被调一次。调用方的 `'error'` 分支必须**先注册**并自行保证幂等 ——
今天靠事件顺序侥幸成立,写下来才不会被下一次改动打破。

### 2.2 为什么还要 `drainMs`,既然实测 Δ=0

Δ=0 是**这台机器、这个平台、这个 node 版本**的观测,不是 API 保证,而且它依赖
§1.1 那个 flowing 前提。**这个 grace 的代价为零**:正常命令的 `close` 在 Δ=0ms 就到,
计时器根本轮不到触发;它**只**影响「有孙进程握管道」这一种情况 —— 那种情况现在是**永不返回**。
取 **250ms**。

**不做「静默多久就收尾」的自适应等待**:吵的孙进程会一直喂数据(实测),
自适应等待在那种情况下永远收不了尾 —— 而那恰恰是最需要收尾的情况。

**已知上界缺失**:消费者若把事件循环堵住,`drainMs` 计时器和 `close` 一起被堵,
250ms 会变成任意长。堵住时任何判据都不管用,但「秒回」的承诺在重负载下不成立,
这一句要写在常量旁边。

### 2.3 收尾之后:**摘监听 + `resume()`,绝不 `destroy()`**

**v1 写的是 destroy,那是错的 —— 实测它会打死孙进程。** 评审的对照实验:

```
不 destroy（对照）:      4.5s 后孙进程心跳 51ms 前  ⇒ 活着
destroy 之后 3s:        孙进程心跳 2774ms 前       ⇒ 已停（写 stdout 拿 EPIPE 自杀）
```

也就是说:按 v1 落地,`pnpm dev &`、`npm start &` 这类**只要打日志的后台进程,
会在 exit + 250ms 被静默杀掉**。用户看到「done」秒回、以为成功,进程无声死掉,
日志里什么都没有 —— 正是本仓最痛恨的失效方式(成功报文 + 静默失效)。

改为**摘掉 `data` 监听 + `resume()`**:node 在 flowing 且无 `data` 监听时读完即丢。
实测(孙进程 80KB/s 灌 6 秒):

```
+2000ms: 孙进程活着；stdout 内部缓冲 0B；RSS 增量 0.3MB
+4000ms: 孙进程活着；stdout 内部缓冲 0B；RSS 增量 0.5MB
+6000ms: 孙进程活着；stdout 内部缓冲 0B；RSS 增量 0.9MB
```

**内存有界、孙进程活着。** 代价照实说:

- 孙进程变成**孤儿**(F P2 原样保留,真解是 Windows Job Object);
- 那两个管道 handle 要等孙进程自己死才释放。
- 前台退出后孙进程的输出**不再计入**这条记录 —— 它是另一个进程的输出,
  不该记到一条已经报了退出码的命令名下。

**要补一个空的 `'error'` 监听。** 流上没有 `'error'` 监听者时 node 直接 throw,
而调用点在定时器/回调栈上、没有任何 catch,本仓也没有 `uncaughtException` 兜底 →
**整个 daemon 死**。这正是 `util.ts:38-48` 已经写下的那条教训(`killTree` 的
spawn 失败炸 daemon):**在调用点包 try/catch 没用,它同步不抛。**

### 2.4 `onExit`:不给它,就会新造一个 zombie 竞态

`run.ts:186-199` 的 kill 兑现是 `kill → signal() → +3000ms 再 signal() → +3000ms → toZombie()`
(`killGraceMs = 3_000`)。若 `finish()` 从「exit 那一刻」推迟到「exit + 250ms」,那么
**exit 落在 `[kill+5750ms, kill+6000ms)` 时**,第二个 grace 先到 → `toZombie()` →
`ended = true`;250ms 后真正的 `finish(code)` 被 `if (this.ended) return` 吞掉。
结果:一条**已经正常退出**的 run 被记成 `zombie` / `exitCode: null`,而
`registry.ts:185-187` 的 `isLive()` 把 zombie 算成活的 → **永久占一个并发额度**。
**本次要修的失效模式,从另一个门回来了。**

所以 helper 必须把「进程死了」和「输出收完了」分开:`onExit` 在 `exit` 事件里**同步**触发,
`run.ts` 拿它立刻 `clearTimer('grace')`、禁止后续 `signal()` 与 `toZombie()`;
只有对外的 `settle()/end` 事件等 `drainMs`。

**顺带把今天就有的一个问题修掉**:孙进程握管道时 close 永不到,两次 `signal()` 会在
kill 后 3s / 6s 打在**已死的 pid** 上;POSIX 分支是 `process.kill(-pid, 'SIGTERM')`
(`util.ts:60`),pid 复用时会误杀无关进程组。

**zombie 这一档保留**,但判据从「close 没来」变成「**发了信号 6 秒还没 `exit`**」
= 进程真的杀不掉。语义比今天准 —— 今天孙进程握管道会让一个已死的进程被判 zombie。

### 2.5 两条必须写在代码旁边的约束

1. `bash.ts` / `run.ts` 的 `data` 监听旁:**别给这条流加 `pause()` / 背压**。
   加了就会让 §1.1 的前提失效 → `drainMs` 到点收尾 → **静默丢一截输出**。
2. `Run.dispose()` 必须调 helper 的 `cancel()`。不清的话,注册表淘汰一条 run
   (`registry.ts:172-174`)之后那个定时器仍会在 250ms 后触发,往已清空的订阅集合发事件;
   daemon 关停时还多挂一个活定时器。

### 2.6 Bash 工具:超时/中断路径要有**自己的**收尾

§1.2 的 ③ 说明:`finish()` 只挂在一条事件上,那条事件不来就永远不返回。
exit 驱动之后 ③ 这个具体场景解决了(exit 在 69ms 就到),但**病根还在** ——
一个扛得住 taskkill 的**前台**进程(不是孙进程)照样让它永不返回。

所以 `killTree` 之后再挂一个**硬截止**:到点无论如何 resolve,文案点破
「命令被要求终止但没有退出」。这是「不许把收尾寄托在一个可能永不到达的事件上」
这条原则的第二处应用,和主修同源。

## 三、落地范围

| 文件 | 改什么 |
|---|---|
| `proc/settle.ts`(新) | `onChildSettled` |
| `proc/index.ts` | 导出 |
| `bash.ts` | close → `onChildSettled`;超时/abort 的硬截止(§2.6) |
| `run/run.ts` | close → `onChildSettled` + `onExit`;`dispose()` 调 `cancel()` |
| `grep.ts` | **不改**:`spawn(rgPath, args)` 不走 shell、`rg` 不 fork |
| `shell-snapshot.ts` | **不改**:`stdio: ['ignore','ignore','ignore']` —— **压根没有管道可握** |
| `tmux-isolation.ts` | **不改**:实测 `tmux new-session -d` 起 server 后 Δ=0ms,自己把 stdio 断干净了 |
| `lsp/install.ts:51` | **不改**:`npm i -g` 不留后台孙进程。列在这里是为了让下一个人知道它被考虑过 |

**判据要换。** v1 写的是「命令是谁给的」,评审证明那个判据**在 `shell-snapshot.ts` 上
给出的是碰巧正确的答案** —— 它跑的是 `bash -i -l -c <脚本>`,会 source 用户的 `.bashrc`,
那是**任意内容**,完全可以起后台进程。它安全的真正原因是 `stdio` 全 `'ignore'`。
实测对照:

```
stdio:'ignore' + 后台孙进程:  exit@87 close@87        ← 没有管道可握
stdio:'pipe'   + 后台孙进程:  exit@77 close@null ***  ← close 未到达
```

**正确判据:①这条流是不是 pipe(有没有管道可握)优先,②命令是谁给的次之。**

## 四、取舍与代价

- **代价 1**:孙进程的输出在前台退出后不再计入(§2.3)。
- **代价 2**:孙进程变成孤儿,管道 handle 等它自己死才释放(§2.3)。
  这是**刻意选的** —— 另一条路(destroy)会打死用户的后台进程。
- **代价 3**:`drainMs` 是个魔数,且在事件循环被堵时没有上界(§2.2)。
- **不做的**:不做孙进程探测(枚举后代树)。跨平台、要轮询,且 exit 那一刻信息已经没了。

## 五、测试点(每条注明「不写它会漏什么」)

1. helper:`close` 先到 → 立刻收尾、`drained:true`、**不等 `drainMs`**。
   (不写它,「一律等满 250ms」的实现也能过其它测试 —— 每条命令白加 250ms。)
2. helper:`exit` 后 `close` 不来 → `drainMs` 到点收尾,`drained:false`,退出码来自 `exit`。
3. helper:回调**至多一次**(计时器到点后 `close` 姗姗来迟,不得回调第二次)。
4. helper:**`signal` 透传**(否则 `[killed by signal: undefined]`)。
5. helper:`onExit` 在 `exit` 事件里**同步**触发,且早于 `cb`。
6. helper:`cancel()` 之后计时器不再触发。
7. helper:收尾后**摘掉了 `data` 监听**、流仍 `readable`(**没有被 destroy**)。
   —— v1 的断言是 `destroyed === true`,方向正好相反,写反了会打死用户的后台进程。
8. **`bash.ts` 端到端(真子进程)**:后台孙进程的命令必须在 2 秒内返回、`isError:false`、
   输出含前台的那行。**且断言孙进程真的起来了**(它写一个心跳文件)。
9. **`run.ts` 端到端(真子进程,项目档)**:同样的命令走到 `status:'exited'`,
   并从注册表**释放并发额度**。必须显式注入真 `spawnShellCommand` + 真 `killTree` ——
   沿用 `run.test.ts` 的假 child 就完全不是端到端。
10. `run.ts`:**exit 落在第二个 grace 窗口里不得变 zombie**(§2.4 的竞态)。
11. ENOENT:`bash.ts` 回「Failed to spawn」而不是 `[exit code: -4058]`;
    `run.ts` 的 `exitCode` 是 `null` 而不是 `-4058`。
12. `bash.ts`:killTree 之后的硬截止到点必须 resolve(§2.6)。
13. **变异验证**:只删 `run.ts` 那一处接线(helper 不动)→ 第 9 条必须红。
    (v1 的变异是「删 helper 的 exit 分支」,太粗 —— 它会让 §5.2 一起红,证明不了接线。)

### 5.1 测试命令的写法(v1 那条会假绿)

**`node -e "…" & echo done` 在 Windows 上活不过 `spawnShellCommand`。** 实测:内层双引号
不被转义,bash 拿到的是没引号的命令行,`=>` 里的 `>` 被当成重定向:

```
setTimeout(()=>{},3000)  变成  setTimeout(()=,3000)   → node 语法错误秒退
②安静后台孙进程: 198ms 返回 isError=false  ← 测试会绿，但测的是"一个语法错误的 node 秒退"
```

**孙进程压根没起来,`close` 当然按时到,把 exit 分支删掉它照样绿** —— 教科书级假绿,
连 §5.13 的变异验证也跟着废。

所以:**脚本落到临时 `.cjs` 文件**,命令写成 `node '<posix 路径>' & echo done`,
并让孙进程写一个**心跳文件**,测试断言它存在 —— 否则没有任何东西能证明这条测试
测的是它自称测的东西。

`&` 的后台语义只在 git-bash / pwsh 下成立,回退到 `cmd.exe` 时它只是顺序分隔符
(`proc/shell.ts` 的第三级回退)。按 CLAUDE.md:`describe.skipIf(...)` + `ctx.skip()`,
**跳过必须在报告里可见**。孙进程要短命,`afterEach` 兜底 kill。

## 六、真跑验证

- 真敲 Bash 工具:一条 `&` 后台化的命令 —— 秒回,而不是**永不返回**(v1 写的基线「120 秒」是错的)。
- 真起 daemon,从页面发起后台化的 run:走到「运行结束」,并发额度回来(连发 9 条)。
- **后台进程要还活着** —— 这条是 v2 新增补救的验收点。

## 七、v1 的三处实质错误(评审推翻)

1. **后果说轻了。** 不是「白等满 120 秒」,是**永不返回**(§1.2 有真跑)。
   顺带漏了 spill 文件无上界增长。
2. **补救会打死用户的后台进程。** v1 的 `destroy()` 让孙进程拿 EPIPE 自杀(实测),
   而 v1 的 §4 还写着「孙进程变成孤儿」—— 自己和自己矛盾。改成摘监听 + `resume()`。
3. **给 run 的状态机开了新的 zombie 竞态**(§2.4),而 zombie 恰好就是本次要修的那个
   「永久占额度」。

另外两条机制/判据错误:§1.1 的「node 一直在读」是错的(真实机制是 exit 之后才强制冲刷,
前提是消费者 flowing);§3 的「命令是谁给的」判据在 `shell-snapshot.ts` 上碰巧对。

## 八、修订记录

- v1(2026-08-14):初稿。
- v2(2026-08-14):按独立评审重写 —— 三处实质错误 + 两处机制/判据错误,
  测试清单从 7 条扩到 13 条(含一条教科书级假绿的写法警示)。

---

## 九、v3 修订：drain 分成两档 + 硬截止（**这次改动当时跳了评审，补记**）

### 9.1 先承认流程问题

`KILLED_DRAIN_MS` 与 `KILL_HARD_DEADLINE_MS` 这两个常量**从未出现在任何 spec 里**，
也没走过独立评审 —— 它们是在实现过程中直接加进代码的，依据只写在代码注释里。
按 CLAUDE.md「设计 → 写 spec → 开新子代理独立评审 → TDD 实现」，这是一次跳步。
2026-08-14 的设计审计把它挑了出来（子进程审计 2-5），本节是补记。

**为什么这条值得补而不是「反正代码是对的就算了」**：本 spec §2.2 现在还写着
「这个 grace 的代价为零：正常命令的 close 在 Δ=0ms 就到，计时器根本轮不到触发……取 250ms」，
而代码里那句已经被推翻。**下一个人读 spec 会以为 250ms 是唯一常量并按那个前提改代码。**

### 9.2 §2.2 那句「代价为零」只对**正常退出**成立

实测（kill 路径，400ms 时 `taskkill /T /F`）：

```
npm view   exit@840ms  close@1534ms  Δ=694ms
  3 次采样：exit+250ms 手上 0 字节，exit+500ms 仍 0 字节，
            全部 105832B 在 exit+1000ms 才到
```

给被杀的进程 250ms，等于把「被停止那一刻的现场」整个丢掉 —— 而那正是模型最需要
日志判断「卡在哪」的时刻，且是**静默**的。

于是 `drainMs` 从常量改成**函数**，在 `'exit'` 事件里求值，按「是不是我们杀的」分档：
正常 250ms，被杀 1500ms（对实测的 694ms 有一倍余量）。

### 9.3 与 §2.2 否决「自适应等待」并不矛盾

§2.2 写过「不做『静默多久就收尾』的自适应等待：吵的孙进程会一直喂数据，
自适应等待在那种情况下永远收不了尾」。那个否决**只对无上界的自适应成立**，
而这里是两个固定值，不是自适应。

**但审计指出这个形状偏弱，我同意**：1500ms 是单条命令、单次 105KB 的标定，
而真实驱动量是「管道里压着多少字节 + 消费者能多快排空」，两者都不在这个常量的视野里。
一条被 kill 的 `pnpm build`（几 MB 日志）没有理由落在同一档。
带硬帽的自适应（**距上次 `data` 静默 250ms 即收尾，总时长不超过 1500ms**）不受
§2.2 那条否决的约束，且严格更好。**列为待办，本轮不做** —— 它要改 settle helper 的
接口（多接一路 `data` 观察）。

### 9.4 `KILL_HARD_DEADLINE_MS = 5_000`（Bash 侧）

病根是「收尾寄托在一个可能永不到达的事件上」：超时定时器只置标志 + `killTree`，
真正 resolve 靠 `close`；而 `killTree` 是 fire-and-forget，杀不掉就永远不 resolve。
所以 `killTree` 之后再挂一个硬截止，到点无论如何 resolve。

**2026-08-14 追加**：到点之前先 `killTreeHard` 一次。这 5 秒本来就是「软杀之后还没退」
的等待窗口，是个天然升级点。WSL 实测（本仓产品代码）：两次 `killTree` 之后目标仍 ALIVE，
SIGKILL 才 DEAD。原注释把「trap 掉 SIGTERM 的进程 5 秒后仍活着」写成**已知代价**，
现在这条代价不必付了。

### 9.5 这两个常量各自的测试

- `KILLED_DRAIN_MS`：单测锁「kill 路径取 1500、正常路径取 250」。
  **e2e 分辨不了这两档**（实测同一条命令两次采样，一次 250ms 内到齐、一次没到），
  这个「分辨不了」本身就说明 250ms 不是可靠上界 —— 已在代码注释里写明，不假装 e2e 覆盖了它。
- `KILL_HARD_DEADLINE_MS`：`ZUSE_BASH_KILL_DEADLINE_MS` 注入口 + 「进程不退时仍然 resolve
  并点破『可能还在跑』」那条用例（现存，绿）。
