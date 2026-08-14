# 权限格缺一档：`confirm`（设计审计 权限-1.1，判为病根）设计

日期：2026-08-14
状态：**v2 —— 已评审。评审否掉了本方案捆进来的一次降级，并查出三处「UI 藏按钮拦不住」的漏洞。实现待下一轮。**

## 一、问题：只有「绝对拒绝」和「能被压过的确认」两档

### 1.1 `decide()` 的实际顺序（实际读出来的）

```
1  tools.enabled/disabled
2  deny
3  Bash 安全闸（hasWholeExactBashAllow 豁免）
3.5 bypass → allow
4  allow（含会话覆盖层）
5  ask
6  defaultMode 兜底（acceptEdits / default）
```

`allow` 在第 4 步、`ask` 在第 5 步。**用户写的任何一条 allow 都会压过内建的 ask。**

### 1.2 这个顺序**逼**着我们把配置文件写成 deny —— 那不是取舍，是唯一可行点

`settings.ts` 里 `DEFAULT_DENY_RULES` 的注释是我自己写的：

> 为什么必须是 `deny` 而不是 `ask`：**allow 在 `decide` 的第 4 步、早于 ask 的第 5 步。**
> 我原本写成内置 ask，实测被用户配置里一条极常见的 `Write(./**)`（本仓自己就有）
> 直接压过 —— 而 `.zuse/settings.local.jsonc` 正好落在 cwd 内。也就是说
> 「防止自我提权」这个目标在真实配置下一次都不会生效。deny 是第 2 步、压过一切。

审计的判断是对的：**我当时把「被顺序逼出来的唯一可行点」写成了「刻意的取舍」。**
我真正想要的是「允许写，但每次必须人点一下」，而**那一档在当前格上不存在**。

于是只能跳到 deny，付掉全部代价：模型再也不能帮用户改 zuse 的配置，
包括「帮我把这个 MCP server 加进去」这种完全正常的请求。

### 1.3 下游：至少三处都是这条缺陷的实例

- **`~/.zuse/**` 只能用 deny**（本轮刚加的）。代价是模型不能帮用户整理 SYSTEM.md、skills。
- **`ZUSE.md` / `MEMORY.md` / `SYSTEM.md` 没有任何保护**。它们**直接进系统提示词**
  （`instructions.ts`），`ZUSE.md` 的标题就叫 "Project instructions" —— 是最直接的指令注入面。
  给它们加 ask 会被本仓自己的 `Write(./**)` 压过，所以今天干脆没加。
- **本仓自己的 `"ask": ["Bash(*)"]` 是一条空规则**。它上面二十多条 `Bash(...)` allow
  全部在第 4 步命中，走不到第 5 步。配置作者（我）以为它在管事。

审计原话：「问题全部集中在**格的形状**上……1.1 是病根，其余都是它的下游。」

## 二、方案

### 2.1 加第三张表 `confirm`，插在 deny 之后、Bash 安全闸之前

```
1  tools.enabled/disabled
2  deny                    ← 绝对拒绝
2.5 confirm                ← **必须确认，且不可被 allow / bypass 压过**   ★新增
3  Bash 安全闸
3.5 bypass → allow
4  allow
5  ask                     ← 可被 allow 压过（保持现状，这是它该有的语义）
6  defaultMode 兜底
```

**必须在 `bypass`（3.5）之前**，否则 cron 会话（`permissionMode` 默认 bypass）会整个跳过它 ——
而那正是最需要它的场景之一。

`ask` 保持在第 5 步不动：**用户自己写的 ask 被自己写的、更具体的 allow 压过是对的**
（「除了这几条以外都问我」是一个合理的表达）。缺的从来不是「ask 更强」，
而是「一档用户 allow 压不过的确认」。

### 2.2 `confirm` 与 `deny` 的分工

| | 用途 |
|---|---|
| `deny` | 无论如何都不行。**没有交互能救它。** |
| `confirm` | 可以做，但**每次**都要人点一次；`allow` 和 `bypass` 都压不过。 |

内建默认的调整：

- `Write/Edit(.zuse/settings*.json*)` 等六条：**deny → confirm**。
  模型能帮你加 MCP server 了，但每次都得你点一下。
- `Write/Edit(~/.zuse/**)`：**deny → confirm**（同上，能整理 skills 了）。
- **`permissions` 段本身仍留 deny** —— 「改 permissions」和「改别的配置」是两件事，
  前者没有任何正当的模型用例。**但这需要字段级判据，而规则语言只到文件级。**
  见 §2.5 的取舍。
- `Write/Edit(**/ZUSE.md)`、`Write/Edit(~/.zuse/{MEMORY,SYSTEM}.md)`：**新增 confirm**。
  这是 1.3 第二条，今天完全没有保护。

### 2.3 非交互会话：`confirm` = deny

cron / 自唤醒会话没有人可问。`decide` 返回 `'ask'`，而 `gateAndRunTool` 在
`canUseTool` 缺席时返回 `'deny'`（既有行为）。**必须写进文档**：
定时任务里想改配置文件会失败，这是刻意的。

### 2.4 UI

`confirm` 命中的弹框要和普通 ask **明确区分**：它不该给「总是允许」这个选项 ——
给了就等于把这一档降级成 ask。选项只有「允许这一次」和「拒绝」。

**这是本方案的核心不变式**：`confirm` 不可被任何持久化规则消解。
若用户真的想永久放行，只能自己去配置文件里把这条 confirm 删掉 ——
那是一个显式的、他自己动手的决定。

### 2.5 明确的取舍与不做的事

- **`decide()` 从 6 步变 7 步。** 这是全仓最不该动的函数。缓解：新分支是**纯插入**，
  不改任何既有分支的相对顺序；既有测试全部应当不变（这本身是一条验收标准）。
- **用户要理解四张表而不是三张。** 缓解：`confirm` 只在内建默认里用，
  用户配置里不写也完全能用；文档把它描述成「比 ask 硬的一档」。
- **不做字段级判据。** 「只保护 permissions 段、别的字段放行」需要解析 JSON 并按路径判，
  而规则语言只到文件级。本轮**整个 settings 文件都是 confirm** ——
  代价是改 `model` 也要点一次。若将来嫌烦，那是「配置文件的结构化编辑工具」那条路，
  不是往规则语言里塞字段路径。
- **不动 `ask` 的位置。** 审计没有要求动它，动了会改变用户既有配置的行为。

## 三、测试计划（TDD）

1. `confirm` 命中 → `ask`，**即使 allow 表里有覆盖它的规则**
   （用 `Write(./**)` + `confirm: ['Write(.zuse/settings*.json*)']`，正是 1.2 那个实测反例）。
2. `confirm` 命中 → `ask`，**即使 `defaultMode: 'bypass'`**（cron 场景）。
3. `deny` 仍然压过 `confirm`（顺序 2 在 2.5 之前）。
4. `confirm` **不**压过 `tools.disabled`（第 1 步仍在最前）。
5. 内建默认：`Write(.zuse/settings.local.jsonc)` 现在是 `ask` 而不是 `deny`
   —— **这是行为变化，要显式锁住**。
6. 内建默认：`Write(ZUSE.md)` 是 `ask`，且 `allow: ['Write(./**)']` 压不过它
   （1.3 第二条，今天是静默 allow）。
7. **既有权限测试一条都不许改。** 这是「纯插入」的验收标准；
   任何一条既有用例需要改，都说明我改动了既有分支的语义。

**变异验证**：
- 把 2.5 挪到 bypass **之后** → 第 2 条必须红。
- 把 2.5 挪到 allow **之后** → 第 1 条必须红。
- 把 `confirm` 的返回值从 `ask` 改成 `allow` → 1、2、5、6 全红。

**真跑验证**：起真 daemon，在本仓（配置里就有 `Write(./**)`）让模型写
`.zuse/settings.local.jsonc` —— 必须弹框，且弹框上**没有**「总是允许」按钮。
再在 cron 档下跑同一条 —— 必须失败而不是照跑。

## 四、代价汇总

- `decide()` 多一步（纯插入）。
- 用户概念多一张表。
- 改 zuse 自己的配置从「不可能」变成「每次点一下」——**这是本方案的收益**，
  但对已经习惯了 deny 的人是行为变化。
- 定时任务改不了配置文件（刻意）。
- 整个 settings 文件粒度，改 `model` 也要点一次。

---

## 五、评审结论（v2）：机制对，**但本方案把两件事捆在了一起，其中一件不该做**

评审的总结论：「spec 的机制（加一档）是对的，它顺带做的那次降级
（settings 文件 deny→confirm）应该拆出来不做。这两件事被捆在一起，是因为 §1.2 把
『deny 太重』写成了唯一的问题陈述；实际是两个问题，只有一个需要新机制。」

**我接受这个判断。** 下面按「必须改」逐条记，实现按这一节走，不按上面的 §2。

### 5.1 【不做】settings 文件从 deny 降到 confirm —— 那是实打实的削弱

评审给了三条理由，都不是理论：

1. **同意疲劳在本仓有现成温床。** 本仓配置下 Bash 每条都要确认，长会话里用户本来就在
   连续机械点卡。而 `PermissionCard.tsx` 只显示「工具名 · 限定符」，**没有任何危险度分级**
   —— 第 N 张写着 `Write · …/.zuse/settings.local.jsonc` 的卡，和前面 N-1 张长得一模一样。
2. **这一条的失败不可逆且自扩散。** 一次误点写进 `defaultMode: "bypass"`，
   从下个会话起 deny/ask **全表**失效，而没有任何界面会告诉用户「你的护栏没了」。
   deny 的期望损失是 0 次点击，confirm 是「每次点一下 × 会话长度」——两者不是线性关系。
3. **它换来的收益已有替代路径**：`POST /api/mcp` → `setMcpServerInSettings`、
   `setModelInSettings`（`PUT /api/model` / TUI）都在仓库里跑着。
   **为一个已有替代方案的用例去松最硬的那把锁，不划算。**

### 5.2 【不做】`~/.zuse/cron/**` 降级 —— 一次误点 = 写下一个自带 bypass 执行器的定时任务

我把它和「整理 skills」混成了一条。那条 deny 当初就是为 cron 加的
（`permissionMode` 默认 bypass，调度器会起非交互 + 全自主的会话跑里面的 prompt）。
而 tasks.json 有结构化写入口（CronService），模型不需要直接写文件。

**修正**：`Write/Edit(~/.zuse/cron/**)` 留 deny，其余 `~/.zuse/**` 转 confirm。代价 0。

### 5.3 【必须做】三处「UI 藏按钮拦不住」的漏洞 —— 这是本方案真正的实现难点

**(a) `matched` 到不了 UI。** `PermissionRequest` 只有五个字段，没有「这是哪一档」的信息；
`agent.ts` 构造请求时把 `matched` 丢掉了。要落地「confirm 卡不给『总是允许』」得动
**四个界面 + 两个类型**：web 的 `PermissionCard.tsx`、TUI 的 `PermissionDialog.tsx`
（`OPTIONS` 是模块级 const，得改成按 req 计算）、`http/devPage.ts` 里那个纯 JS 界面、
以及 protocol。**我 §2.4 一处都没提。**

**(b) 藏按钮 ≠ 关掉那条路。** 协议层只校验 verdict 是四个字面量之一，任何客户端
（含 devPage）都能发 `allow_persist`。而 `sessionAllow` 只并进**第 4 步**的 allowRules，
confirm 在 2.5 —— 于是用户点「始终」会写下一条**永远不生效**的规则，下次照样弹框、
没有任何提示，规则还永久留在盘上。**这正是本仓最恨的失败形状**（「配了、看得见、
没生效、没提示」），而我的方案会**新造**一个。
→ 兜底必须在**服务端**：`decide()` 返回可判别标记，`gateAndRunTool` 对 confirm 命中把
`allow_session`/`allow_persist` 降级成 `allow` 并回一句说明；`recheckSpecifier` 同样要覆盖。

**(c) 切「全自主」会把屏上已有的 confirm 卡一并结算成 allow。**
`SessionManager` 在 `mode === 'bypass'` 时遍历 `pending` 全部 `resolve('allow')`。
`decide()` 确实返回了 ask —— 是**上层替用户按掉的**。
**我的测试 2（只测 `decide()`）会绿，而真系统漏。** 教科书级的「测试绿 ≠ 能用」。

### 5.4 【必须改】§2.4 的逃生口不存在

我写「用户可以自己去配置文件里把这条 confirm 删掉」。`mergeLayers` 只有 push、
没有任何删除/否定语法，内建默认在源码常量里，配置层删不掉。
**这句话是错的**，要么删掉改成「只能改源码」，要么这一轮就设计关闭机制。

### 5.5 【改形状】`confirm` 不必进 `ResolvedSettings`

我 §2.5 自己说「confirm 只在内建默认里用，用户配置里不写也完全能用」。
既然如此，做成 `permission.ts` 的模块常量 `BUILTIN_CONFIRM_RULES` 就够，
收益一模一样，但省掉：`types.ts` 的 `PermissionsConfig`（连带 57 处内联字面量、
26 处 `as ResolvedSettings`）、`RawSettings` / `mergeLayers`、启动体检的取值方式、
`/config` 输出。**注意这省不掉 5.3 的三条** —— 那些是 decide 之外的下游。

### 5.6 【改位置】放在 Bash 安全闸**之后**，不是之前

判定结果零差异，但安全闸返回的 `matched: 'security:…'` 与 `reason` 是对话框要渲染的
（「⚠ 安全检查：…」）。放在闸前会把「为什么被拦」的说明盖掉。
顺序改成 `deny → 安全闸 → confirm → bypass`。

### 5.7 【改验收标准】「既有测试一条都不许改」不成立

评审实际 grep 出至少 5 处必改，其中 4 处是断言值本身（`permission.test.ts:187-195`、
`permissionAudit.test.ts:95/101` 都直接断言 `'deny'`）。另有 26 处 `as ResolvedSettings`
的假件在加必填字段后会运行期 TypeError（编译器不报）。
→ 改成：「只有**内建默认档位变化直接导致**的断言可以改，且每条都要在 spec 里列出来」。
（走 5.5 的常量方案可以避开类型那一半。）

### 5.8 结论：本轮该做的是一个**小得多**的改动

综合下来，净收益的部分只有一条：**给今天完全零保护的三个文件加上一档
allow 压不过的确认** —— `ZUSE.md`、`~/.zuse/SYSTEM.md`、`~/.zuse/MEMORY.md`。
它们直接进系统提示词，是最直接的指令注入面，而 deny/ask 两张默认表里对它们一条规则都没有。
从零到 confirm **不存在削弱**。

settings 文件与 cron 保持 deny。

评审还提示 `ZUSE.md` 的代价可能被低估（它是项目指令文件，用户经常主动让模型改，
而按 5.4 用户关不掉），建议只硬保护全局的 `~/.zuse/{SYSTEM,MEMORY}.md`，
项目内 `ZUSE.md` 放普通 ask。**这一条实现时再定，需要先解决 5.4 的关闭机制。**

命名另需注意：run 服务已用 `confirmed` 表示另一件事（`execConsent`），
考虑改叫 `mustConfirm` / `hardAsk`。
