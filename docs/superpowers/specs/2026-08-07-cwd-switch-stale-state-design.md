# 切换工作目录后的状态错位 —— 设计 v2

> 会话中 `cd` 到另一个项目，只有 `this.cwd` 改了，**技能、记忆、系统提示词全部停留在旧目录**。
> 不是「两个目录的东西混在一起」，是「人在新目录、用的是旧目录的东西」。
>
> v1 被独立评审判为「不能进入实现」：核心决策 §3.1 建立在一个**事实错误**上，
> 照它实现最常见的用法依然坏；另有两个会静默毁掉功能的陷阱没提；还漏了一整类烧死状态。

## 0. v1 错在哪

| v1 的说法 | 实际 |
|---|---|
| §3.1「模型这一轮的工具清单是回合开始时发出去的，中途换必然对不上，所以在**用户回合边界**结算」 | **前提是错的**。`agent.ts` 的 `runAgent` 主循环**每个 model round 都重取** `registry.getDefinitions(...)`，注释明写「Re-read each turn so dynamically registered tools become visible on the next turn」（McpSearch 已是先例）。实测：在 `cwd-change` 那一刻就地换掉 `Skill` 工具，**round 2 就能看到新技能**。<br>照 v1 实现，「cd 到 B，然后用 B 的 deploy 技能」这个**最典型的触发方式**全程失效，直到用户再发一条消息 |
| §3.1 担心「换表后模型点名的工具不存在 → unknown tool」 | **不会发生**。技能不是一个个工具，是**一个** `Skill` 工具把清单拼进 description。名字恒定，只有描述变 |
| §3.1 担心并发批里「已在飞的工具持有旧 registry 引用」 | 方向反了。`BashTool` **没有** `readOnly`，带 `cd` 的批**必然串行** |
| §3.2 只说「要换技能与记忆」，做法是重建 registry | **重建会静默废掉子代理**：`Agent` 工具在构造时就捕获了 registry 对象引用，换新对象后它永远指着旧的，无报错无日志 |
| §1.3 列了三类烧死状态 | **漏了第四类：systemPrompt**（含 cwd 字面量 + 项目 `ZUSE.md`）。见 §2.4 |
| §1「记忆完全不跟 cwd」 | **是分裂的**，和 v1 自己在 §1.4 描述权限时那张表一模一样的病，但没发现。见 §2.5 —— 而且后果比「读不到」严重得多 |
| 全文标「行号为实际行号」 | 行号在写的时候是对的，**之后被后续提交冲掉了**（权限模式开关往 `SessionManager.ts` 加了行；`bash.ts:258→229` 是抽进程层那次从 459 行缩到 245 行造成的）。<br>**结论不是「下次小心」，是「会比代码活得久的文档不该拿行号当锚点」** —— v2 全文改引符号名 |

## 1. 事实（引符号，不引行号）

- **唯一触发路径**：Bash 工具里的 `cd` → `applyCapturedCwd` → `ctx.setCwd` → `agent.ts` 的 `onCwdChange`。
- **回调只做两件事**：`this.cwd = next` + `emit({type:'cwd-change'})`。不重扫、不重建、不重读。
- **建会话时烧死**（`createSession`）：`scanSkills(home, cwd)` 与 `memoryProject: cwdSlug(cwd)` 进 `createDefaultRegistry`；
  `loadPromptSections(home, cwd)` + `buildSystemPrompt({...cwd...})` 拼成 `systemPrompt` 字符串。
- **权限是分裂的**：规则表来自 `findProjectRoot()`（**daemon 进程 cwd**，无参函数），不跟；
  匹配基准用 `this.cwd`，跟。后者是对的，前者见 §5。
- **实测复现**（评审代理跑的，脚本可复用为回归骨架）：
  ```
  建会话(cwd=A):  Skill 列出 alpha? true   beta? false
  cd 到 B 之后:   mgr.cwd = B（跟了）      Skill 列出 alpha? true  beta? false（没跟）
  对照重扫 B:     含 beta? true            含 alpha? false
  ```

## 2. 修什么

### 2.1 结算点：工具批边界，不是用户回合边界
`cd` 发生在一次工具执行内部。**在本轮工具批跑完、下一次 `getDefinitions` 之前**就地替换。
与 McpSearch 中途注册同构，代价为零。
（一个回合里 `cd` 两次没问题，每次替换幂等。并发子代理批中途替换会让同批技能集不一致 ——
概率极低，「批结束后再结算」这一句话即可消掉。）

### 2.2 不重建 registry，只就地替换两个条目
换：`Skill`、`Memory`。
**不动**：`MCP`、`LSP`、`Agent`、`TodoWrite`、`ScheduleWakeup` —— 天然零风险，
比 v1 设想的「重建 + 小心别弄丢」简单一个量级。

额外收益：`agent-tool.ts` 的 `buildChildRegistry` 是**调用时**克隆父 registry，
所以就地改能被子代理自动接住。

### 2.3 需要新增 `ToolRegistry.replace()`
`ToolRegistry` 现在只有 `register / get / list / getDefinitions`，
`register` 遇重复键**直接抛**（`Tool already registered: X`），没有 replace / unregister。
就地替换目前**做不到**。

加一个**独立**的 `replace(tool)`，**不要放宽 `register` 的抛出** ——
CLAUDE.md 明确「注册表遇重复键直接抛」是刻意设计（重复注册在运行期表现为「某项神秘失效」）。

**顺带**：`Skill` 工具现在只在「技能数 > 0」时注册，全禁用时工具不存在，
于是 `cd` 会遇到「需要新增/需要删除」两个方向（后者 `ToolRegistry` 做不到）。
改成 **`Skill` 恒注册、空列表时描述里写明无可用技能**，两个分支一起消掉。
代价：多几百 token 的常驻工具定义。

### 2.4 systemPrompt / `ZUSE.md`：做，并写明代价
`cd` 后系统提示词仍写着 A 的目录，且 **B 的 `ZUSE.md` 项目规则一条都不生效** ——
从 zuse 仓库 `cd` 到别的项目，模型会继续按 zuse 的「合本地 master、不 push origin」干活。
**对这个仓库而言这比技能错位更严重。**

技术上可行：`systemPrompt` 非 readonly，且 `getSystemPrompt: () => this.systemPrompt` 本就是为热替换设计的取值函数。

**代价必须写进 spec**：系统块保持 byte-identical 是为了 **prompt cache**（代码里有注释说明）。
重建它会让缓存失效，`cd` 那一刻多付一次全量 input token。**接受这个代价** ——
按错误的项目规则干活的损失更大，且 `cd` 跨项目是低频动作。

### 2.5 记忆：先修一个今天就存在的数据问题
两处不同源：
- 记忆工具：`createMemoryTool(o.memoryProject ?? '')` —— 建会话时烧死
- 巩固：`applyMemoryConsolidation(ops, cwdSlug(this.cwd))` —— **活 cwd**

而 `applyMemoryConsolidation` 内部是 `store.save(..., project, ...)` 然后 `store.remove(id)`，
`store.all()` 读的是**全库所有项目**的行。净效果：

> **`cd` 之后一旦触发巩固，A 项目的记忆会被改挂到 B 项目名下，源行删除。**
> 而巩固是 fire-and-forget、`catch {}` 全吞，出事没有任何痕迹。

**这条独立于本功能，今天就在发生，优先级更高，单独修**：两处必须同源。

本设计范围内：记忆项目跟随 cwd 切换。切过去后 A 的 project/insight/reference 读不到
（user 型强制全局，不受影响）。用户观感是「记忆丢了」—— 所以 §3 的提示必须说清是「换柜子」不是「丢了」。

### 2.6 `reset()`（新对话）也要重扫
`reset()` 刻意保留环境（model client / registry / settings / systemPrompt / cwd）。
用户察觉不对点「新对话」，以为重置了，其实技能/记忆/提示词仍是 A 的。

**反向证据很有意思**：`SessionService` 存的是**活** cwd，`getOrLoad` 用它重建 ——
所以**重启 daemon 后同一会话自动按新 cwd 重扫，bug 自愈**。
同一个会话「重启前坏、重启后好」本身就够抓狂，同时也反证**「按新 cwd 重扫」才是系统的既定语义**。

采纳 §2.1 的就地方案后这条天然覆盖，但要有测试锁住。

## 3. 提示：必需，不是可选
技能集**静默变化**和**静默不变**，同样都是静默。`cwd-change` 事件要带上：

- 技能：`N → M`
- 记忆：「已切到 <B 目录名>，A 的记忆仍在但本会话不再可见」（数据现成：`/api/projects` 已经在做 slug→cwd 反查）
- 权限：「规则仍来自 <daemon 项目根>」—— 把 §5 那条不一致**显式化**

**不做模态弹窗**：`cd` 发生在工具执行中途，此刻插一个模态会和权限队列、steer 折叠搅在一起。非阻断提示足够。

## 4. 不做「禁止会话中途换 cwd」
考虑过让 `cd` 只在本回合有效、换项目必须开新会话。**不采纳**，两条实证理由：
1. 现有代码已在多处按「`cd` 跨回合持久」实现并写了注释，且 `SessionService` 存的是活 cwd。改回去是回退既定语义，还要动持久化。
2. 重启 daemon 后同一会话自动按新 cwd 重扫（§2.6）—— 系统的既有立场就是「会话可以合法地活在新 cwd 上」。禁止它反而制造新矛盾。

## 5. 明确不在范围内
- **规则表跟随 cwd**：`findProjectRoot()` 无参、直接用进程 cwd，改它等于改所有会话的权限来源，
  安全语义要重新论证。单独立项。**但 §3 的提示里要显式说明这条不一致**，否则修完更让人困惑。
- **LSP**：不是「安全所以不动」，是**本来就已经错位** —— `LspManager` 的 cwd「首次调用 setCwd 时固定」，
  而整个 daemon 只有一个实例，根由「哪个会话先用了 Lsp」决定。列进「不要换」没错，
  但要写明是**已知遗留错位**，否则实现者会以为 LSP 没问题。
- **禁用表重读**：不重读。理由不是 v1 说的「两种时机并存难解释」，而是
  **重读会让技能面板的启停通过一个不相干的动作（`cd`）生效，是隐式耦合**。

## 6. 测试
- `cd` 到含 `.zuse/skills` 的目录 → **本回合的下一个 model round** 技能集就包含该目录的技能
  （**不是**「下一个用户回合」—— v1 那条测试锁的是错误行为，删掉）
- `cd` 回原目录 → 技能集恢复
- **子代理接住新技能**：`cd` 后派子代理，它拿到的是新目录的技能（锁 §2.2 的「不重建」）
- `MCP` / `LSP` / `Agent` / `TodoWrite` 在替换后仍然在
- systemPrompt 重建后含新 cwd 与 B 的 `ZUSE.md`
- 记忆项目跟随；且**记忆工具与巩固两处同源**（锁 §2.5）
- `reset()` 后仍是新 cwd 的技能集
- 全禁用技能时 `Skill` 工具仍注册（锁 §2.3 的常注册决定）
- **变异验证**：去掉就地替换 → 上述断言变红；把 `replace` 换成 `register` → 抛错
