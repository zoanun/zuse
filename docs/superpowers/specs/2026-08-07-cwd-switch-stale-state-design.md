# 切换工作目录后的状态错位 —— 待实现

> 会话中 `cd` 到另一个项目，只有 `this.cwd` 改了，**技能、记忆、工具注册表全部停留在旧目录**。
> 不是「两个目录的东西混在一起」，是「人在新目录、用的是旧目录的东西」。
> 状态：**已定位，待设计评审后实现**。

## 1. 事实（全部来自实读，行号为实际行号）

### 1.1 唯一的触发路径
`cd` 只能通过 Bash 工具生效：`bash.ts:258` 捕获 cwd → `ctx.setCwd` → `agent.ts` 的 `onCwdChange`。
没有其它入口（UI 的目录选择器是**建新会话**时用的，不走这条）。

### 1.2 回调只做了两件事
`SessionManager.ts:1112-1115`：
```ts
onCwdChange: (next: string) => {
  this.cwd = next
  this.emit({ type: 'cwd-change', cwd: next })
},
```
**没有重建 registry、没有重扫技能、没有重绑记忆、没有重读配置。**

### 1.3 三类状态在建会话时被烧死
`createSession.ts:114-118`：
```ts
const registry = createDefaultRegistry({
  webSearch: getWebSearchConfig(settings),
  memoryProject: cwdSlug(cwd),                                    // ← 记忆项目，绑死
  skills: scanSkills(home, cwd).filter((s) => !disabledSkills.has(s.name)),  // ← 技能，扫一次
})
```
`scanSkills(home, cwd)`（`skills.ts:122`）沿 cwd 向上逐级收集 `.zuse/skills`，内层同名覆盖外层。
结果进 registry 后不再更新。

### 1.4 权限是**分裂**的（一半跟、一半不跟）

| | 跟 cwd 走？ | 依据 |
|---|---|---|
| 规则表内容（allow/ask/deny） | **不跟** | `loadSettings()` → `findProjectRoot()` 从 **daemon 进程 cwd** 往上找 `pnpm-workspace.yaml`（`settings.ts:77`）。与会话 cwd 无关，且每会话只读一次（`createSession.ts:80`） |
| 规则匹配基准（`./**` 的 `.`） | **跟** | `cwd: this.cwd` 每回合现取（`SessionManager.ts:1101`）；`agent.ts:238-239` 注释明说「让本回合后续工具看到新目录」 |

匹配基准跟着走**是对的**（`2026-08-07-permission-glob-escape-design.md` 修完后，
`Write(./**)` 的围栏会随 `cd` 移动，这正是期望行为）。
规则表不跟是另一个话题（见 §4），本设计不动它。

## 2. 用户可感知的后果

1. **技能错位**：人在 B 项目，可用的是 A 项目的技能；B 项目自己的技能一个都加载不到。
2. **记忆错位**：新写的记忆挂到 A 项目名下；B 项目已有的记忆读不到。
3. 两者都**没有任何提示** —— 界面只显示 cwd 变了，看不出技能/记忆没跟上。

## 3. 待解决的设计问题（实现前必须想清楚）

### 3.1 时序：回合进行到一半换工具集
`cd` 发生在**一次工具调用内部**，而同一回合后面还可能有并发的工具调用
（`agent.ts:351` 有并发批的逻辑）。此刻替换 registry 意味着：
- 已经在飞的工具持有旧 registry 的引用吗？
- 模型这一轮已经"看见"的工具清单会不会和实际可调的对不上（工具在 tool_use 里被点名，
  但换表后不存在了 → 报 unknown tool）？

**倾向**：不在回合中途换，**在回合边界（turn-end）结算**。
`cd` 当下只记一个「待重扫」标记，下一回合开始前统一重建。
理由：模型这一轮的工具清单是回合开始时发出去的，中途换必然出现清单与现实不符。

### 3.2 换掉哪些、不换哪些
- **要换**：技能（`scanSkills`）、记忆项目（`memoryProject`）
- **不要换**：MCP 工具（daemon 持有连接生命周期，见 `createSession.ts:109-110` 注释）、
  LSP、会话级工具（Agent / TodoWrite，由 SessionManager 的能力清单注册）
- **待定**：`webSearch` 配置（来自 settings，settings 本身不跟 cwd 走，所以不用换）

### 3.3 要不要告诉用户
技能集变了是**用户应当知道**的事（他可能正指望某个技能存在）。
倾向：`cwd-change` 事件里带上「技能从 N 个变成 M 个」，界面给一句轻提示。
不做提示的话，这个修复会变成另一种静默行为。

### 3.4 `~/.zuse/skills-disabled.json` 的重读时机
`createSession.ts:111-112` 的注释明说「每次新会话重读 → 面板里的启停在下一个新聊天生效」。
重扫技能时要不要顺带重读禁用表？**倾向不要** —— 那会让这条既有约定在 `cd` 时被意外打破，
两种时机并存更难解释。保持「只在新会话重读」。

## 4. 明确不在本设计范围内

- **规则表跟随 cwd**：让 `loadSettings()` 读会话 cwd 的项目配置而不是 daemon 的。
  这是个**更大**的改动（影响所有会话的权限来源、涉及多项目并存时的安全语义），
  且与本条正交。单独立项。
- **UI 里直接切 cwd**：目前只能靠 `cd`。是否给目录选择器一个「在当前会话切换」的入口，另议。

## 5. 测试要求（实现时）

- `cd` 到含 `.zuse/skills` 的目录 → **下一回合**技能集包含该目录的技能
- `cd` 回原目录 → 技能集恢复
- 回合**中途** `cd` → 本回合工具清单不变（锁 §3.1 的决定）
- 记忆项目跟随（写一条记忆，`cd` 后读得到/读不到符合预期）
- MCP / LSP / 会话级工具在重建后**仍然在**（这是最容易在重建 registry 时弄丢的）
- **变异验证**：把重建逻辑去掉，上述断言必须变红
