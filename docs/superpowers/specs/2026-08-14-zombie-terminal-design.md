# run 的 zombie 是不可逆终态（设计审计 子进程-1.1）设计

日期：2026-08-14
状态：**v2 —— 已评审并落地。** 评审改掉了本 spec 的手段和三处事实错误，见文末「评审结论」。

## 一、问题

### 1.1 「升级重杀」发的是同一个信号 —— 它防不住它注释里声称要防的东西

```
packages/tools/src/run/run.ts:257-262
    // 宽限到点仍没 close → 升级再杀一次（POSIX 的 SIGTERM 可能被忽略）。
    this.graceTimer = setTimeout(() => {
      this.signal()
      // 第二个宽限还不死，就认了：转 zombie 并明确报出去，不静默消失。
      this.graceTimer = setTimeout(() => this.toZombie(), this.policy.killGraceMs)
    }, this.policy.killGraceMs)
```

`signal()` → `this.deps.killTree(pid)`，而 POSIX 分支是：

```
packages/core/src/kill-tree.ts:44-50
  } else {
    try {
      process.kill(-pid, 'SIGTERM') // 负 pid = 整个进程组
    } catch {
      process.kill(pid, 'SIGTERM')
    }
  }
```

注释的前提是「SIGTERM 可能被忽略」，而「升级」动作是**再发一次同样的 SIGTERM**。
对一个 trap / ignore 掉 SIGTERM 的进程，重发 N 次与发 1 次完全等效。

**这条缺陷在本仓已经被写下来过一次**，但只在 bash 侧被当成已知代价：
`bash.ts` 的 `KILL_HARD_DEADLINE_MS` 注释写着「POSIX 上 `killTree` 只发 SIGTERM、
没有 SIGKILL 升级，所以一个 trap 掉 SIGTERM 的进程在这 5 秒后仍然活着」。
run 侧则把它当成「已经解决了」。

顺带一处不一致：`killTreeSync`（退出兜底）用的**是** SIGKILL，而 `killTree` 用 SIGTERM。
同一个概念两种强度，且强的那个在更晚的路径上。

### 1.2 `zombie` 没有出口，而它占着并发额度

`_status` 全文件只有三个写点：

```
packages/tools/src/run/run.ts:253   this._status = 'killing'
packages/tools/src/run/run.ts:362   this._status = 'zombie'
packages/tools/src/run/run.ts:368   this._status = 'exited'
```

`:368` 在 `finish()` 里，而 `finish()` 开头是 `if (this.ended) return`；
`toZombie()` 调用的 `settle()` 已经把 `ended` 置真。
**所以进程后来真的死了，状态也不会回到 `exited`。**

而 zombie 被算成活的、且直接卡新建：

```
packages/tools/src/run/registry.ts:212-214
function isLive(status: RunStatus): boolean {
  return status === 'running' || status === 'killing' || status === 'zombie'
}
packages/tools/src/run/registry.ts:87
    if (this.liveCount() >= this.maxConcurrent) throw new RunLimitError(this.maxConcurrent)
```

`maxConcurrent` 默认 8（`registry.ts:81`）。

### 1.3 完整链条

POSIX 上一个 graceful-shutdown 卡住的 dev server（vite / webpack / nodemon **都** trap SIGTERM）
→ 两轮 SIGTERM 都无效 → `zombie` → 永久占一个额度 → 攒够 8 个
→ **run 服务对整个 daemon 彻底失效，只能重启 daemon**。

这正是 `run.ts:358` 那段注释自称「正是这次要修的失效模式」的那一个，从第三个门回来了。

Windows 侧 `taskkill /T /F` 是硬杀，zombie 罕见 —— 但 `killTree` 的 Windows 分支把
spawn 失败**静默吞掉**（`kill-tree.ts:27-43` 的 `'error'` 监听器），杀不掉时同样落到这条路。

### 1.4 我**没有**实测的部分（说清楚）

**本机是 Windows，POSIX 那条主路我跑不了。** 上面 1.1/1.2 全部是源码层证据
（信号常量、`_status` 写点、`isLive` 的三个分支都是无分支的直读）。
但「vite/webpack trap SIGTERM 因而 zombie 可达」这一步是**推论**。
如果评审认为需要，应当在 Linux 上补一次真跑再落地，而不是事后。

Windows 侧我可以实测 `killTree` spawn 失败被吞掉这一支 —— 但那需要构造 taskkill 不可用，
价值不大。

## 二、方案

### 2.1 两件事一起做，缺一不可

**(a) 让升级是真的升级。** `killTree(pid, opts?: { hard?: boolean })`：
- 缺省（`hard` 未传）：维持今天的行为，POSIX 发 SIGTERM，Windows `taskkill /T /F`。
- `hard: true`：POSIX 发 **SIGKILL**；Windows 不变（本来就是 `/F`）。

`run.ts` 的第二次 `signal()` 传 `hard: true`。

代价：SIGKILL 不给进程清理机会（临时文件、它自己的子进程）。但这是**第二轮宽限之后**
才发生的，本来就是最后手段；而现在的替代品是「永远杀不掉 + 永久占额度」。

**(b) `zombie` 不能是终态。** `toZombie()` 之后挂一个低频探活（`process.kill(pid, 0)`；
Windows 用同样的手段——`process.kill(pid,0)` 在 Windows 上也能探测存在性），
进程真死后把状态降级成 `exited` 并释放额度。

代价：每个 zombie 挂一个低频定时器（建议 5s，且 `unref()` —— 绝不能因为它让 daemon 不退出）。

### 2.2 为什么不只做 (a)

(a) 把 zombie 的**发生率**压到极低，但压不到零：`SIGKILL` 也杀不掉的进程存在
（不可中断的 D 状态、内核态卡住）。只做 (a) 的话，剩下那些仍然是永久占额度。
**(b) 才是那条「不可逆」本身的修复**，(a) 是减少触发。

### 2.3 为什么不做审计建议的 (c)「给注册表一个忘掉 zombie 的显式口子」

审计把它列为最低成本兜底。**不做**，理由：它把一个自动可判定的事实
（进程死没死，`kill(pid,0)` 一问便知）变成需要用户判断的操作，而用户手上没有
比 daemon 更多的信息。(b) 的成本只比它高一个定时器。

如果 (b) 之后仍有卡住的场景，再考虑 (c)。

## 三、测试计划（TDD）

`run.test.ts` / 新增用例，全部用注入的假 `killTree`（`RunDeps` 本来就注入它）：

1. **第二次 kill 传了 `hard`**：假 killTree 记录每次调用的 opts；
   走完两轮 grace，断言调用序列是 `[{}, {hard:true}]`。
   （变异：把第二次的 `hard` 去掉 → 必须红。）
2. `killTree` 单测：`hard: true` 时 POSIX 分支发 `SIGKILL`（注入假 `process.kill`）。
3. **zombie 会自愈**：进入 zombie 后，让探活函数返回「已死」→ 状态变 `exited`、
   `endReason` 保持 `zombie`（**别改写原因** —— 它确实是从 zombie 恢复的，不是正常退出）。
4. **自愈后释放额度**：注册表建满 `maxConcurrent` 条并让其中一条变 zombie 再自愈，
   断言可以再建一条。（这条是本次的**核心**，直接对着 1.3 那个失效模式。）
5. 探活定时器 `unref()`：断言它不会阻止进程退出 —— 用真子进程跑一个「进入 zombie 后
   什么都不做」的脚本，断言它能自己退出（否则这个修复会把 daemon 变成退不掉）。
6. 仍然活着时不降级：探活说「还活着」→ 状态保持 `zombie`。

**变异验证（两处）**：
- 第二次 `signal()` 去掉 `hard` → 第 1 条红。
- 自愈时不释放额度（只改状态不动注册表）→ 第 4 条红。

**真跑验证**：Windows 上起一个真的长跑 run，人为让它进 zombie（把 `killGraceMs`
调到很小，复用 `run.ts:355` 注释里记的那组反例参数），确认它随后自己降级成 `exited`
且额度被释放。**POSIX 的 SIGKILL 升级本机跑不了，报告里必须标明这一条未验证。**

## 四、代价汇总

- SIGKILL 升级：第二轮宽限后不给清理机会。
- 每个 zombie 一个 5s 低频定时器（`unref`）。
- `killTree` 签名加一个可选参数；三个既有调用点不变。
- **POSIX 主路无法在本机验证** —— 这是本设计最大的未覆盖面。

---

## 五、评审结论（v2）

独立评审复跑了每一条断言，**问题成立、方案要换**。它改掉的东西：

### 5.1 手段：探活定时器是多余的（评审 F1）

我原本设计「zombie 之后挂一个低频探活」。评审指出：`settle()` **只清 wall/idle/grace
三个表，没有 `settleHandle.cancel()`**（那只在 `dispose()` 里），所以进 zombie 之后
`child.on('exit')` **仍然挂着**，回调照样会被调到。轮询是在重新发明一个已经存在的事件。

改成在 `onProcessExit()` 里一行 `if (_status === 'zombie') _status = 'exited'`。
**顺带消掉三条只有轮询才会有的风险**：`process.kill(pid,0)` 的 EPERM 误判
（评审实测 Windows 上 `pid 4` 返回 EPERM，最自然的 `catch{判死}` 写法会把活进程判死）、
定时器泄漏（`unref()` 只保证不挡退出、不保证不泄漏）、pid 复用。

**目标对，手段选复杂了。**

### 5.2 形状：`killTreeHard` 而不是 `killTree(pid, {hard})`（评审 F12）

「谁在硬杀」应当是**可 grep 的事实**。可选布尔会让 `bash.ts` / `lsp/client.ts` 那几个
语义上也该硬杀的调用点静默保持软杀 —— 缺省值替它们做了决定。

### 5.3 三处事实错误

- **§4 说「三个既有调用点不变」—— 实际是 5 个**，且 `RunDeps.killTree` 的类型必须一起改，
  测试假件 6 处。「三个」会让实施者低估改动面。
- **变异验证第 2 条不可执行**：我写的是「自愈时不释放额度（只改状态不动注册表）」，
  但 `liveCount()` 是每次现算 `run.status`，注册表里**没有**需要「动」的额度状态。
  换成「把自愈那行删掉」。
- **§1.4 说「POSIX 主路本机跑不了」—— 错了，这台机器有 WSL。**
  评审跑了，我也复核了一遍（`esbuild` 把 `kill-tree.ts` 打成 mjs → WSL node 执行，
  用的是**产品代码**不是等价脚本）：

  ```
  node: v18.19.1
  目标 pid=5596  起始: ALIVE
  killTree 第 1 次之后: ALIVE
  killTree 第 2 次之后: ALIVE   ← 旧代码两轮宽限的终点
  killTreeHard 之后:    DEAD
  ✓ 升级链成立
  ```

  所以 §1.1/§1.3 的 POSIX 前提**不再是推论，是实测**。主动标注未实测是对的习惯，
  但这次结论下早了 —— 该先找找有没有环境。

### 5.4 采纳但未在本轮落地的

- **F6**：`bash.ts:51` 的注释说「`killTree` 没有 SIGKILL 升级」，改完之后对 `killTree`
  本身不再成立（只是 bash 这条路没传 hard）。而 `bash.ts` 的超时/abort 之后紧跟
  `armHardDeadline()` 等 5 秒 —— 那是个天然升级点。**下一轮**。
- **F8**：`RailExec.tsx` 的 zombie 文案在自愈之后会变假，且自愈**不发事件**
  （注册表的内部订阅在第一次 end 就 `off()` 了），已连着的前端不知道它恢复了。
  额度释放是主要痛点，但 UI 应当按 `status==='exited' && endReason==='zombie'` 换一句话。
- **F7**：评审指出我否决「手动忘掉 zombie」的理由不成立（用户能开任务管理器看，
  信息比 daemon 多），但给了一条更强的反对理由：忘掉一个还活着的 zombie =
  那个进程从此谁也管不到，正是 `run.ts` 第一条规则明令禁止的。结论不变，理由换掉。
