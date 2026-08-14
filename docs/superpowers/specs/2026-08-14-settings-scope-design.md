# 配置与权限的作用域锚点（设计审计 1-1）设计

日期：2026-08-14
状态：待独立子代理评审

## 一、问题：配置锚在 daemon 的 cwd，会话却能 root 到任意目录

### 1.1 证据链（四条，全部实际读出来的原文）

**① 项目根是从 daemon 进程的 `cwd()` 往上找的**，跟会话无关：

```
packages/core/src/settings.ts:165-172
export function findProjectRoot(): string {
  let dir = cwd()
  while (dir !== resolve(dir, '..')) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
    dir = resolve(dir, '..')
  }
  return cwd()
}
```

**② `createSession` 拿到了会话的 cwd，却调用不带参数的 `loadSettings()`**：

```
packages/server/src/session/createSession.ts:79-80
  const { sessionId, cwd } = opts
  const settings = loadSettings()
```

`loadSettings()` **没有**接收根目录的参数（只有 `projectPath` / `localPath` 两个精确文件路径的
测试用逃生口，`settings.ts:319-322`），所以它永远解析到 daemon 的项目根。

**③ 会话的 cwd 是任意的**，只校验「是不是一个目录」：

```
packages/server/src/http/server.ts:433-441
      const cwd = body?.cwd
      if (cwd !== undefined) {
        try {
          if (!(await stat(cwd)).isDirectory()) { … 400 … }
```

而且 `GET /api/dirs` 的目录选择器是**刻意不设限**的（注释原话：
"Unrestricted on purpose (chooser for a new session's cwd)"）。

**④ 判权时 settings 与 cwd 来自两个不同的地方**：

```
packages/server/src/session/SessionManager.ts:695-696
      const settings = { ...this.settings, permissions: this.policy.config }
      const { decision } = decide(tool, req.specifier, settings, [], this.cwd)
```

`this.cwd` 是**会话的**，`settings` 是 **daemon 项目的**。

### 1.2 两个后果，第二个更严重

**（a）读：别的项目自己的 deny 规则一条都不生效。** 在 `D:\某项目` 里开的会话，
吃的是 `E:\ai-study\zuse\.zuse\settings.local.json`。那个项目在自己 `.zuse/settings.json`
里写的 `deny` **完全不被读取**。

**（b）写：在别的项目里点一次「总是允许」，规则落进 zuse 自己的配置，从此对所有会话永久生效。**

```
packages/core/src/settings.ts:335-336
export function appendAllowRule(rule: string, localPath?: string): void {
  const basePath = localPath ?? join(findProjectRoot(), '.zuse', 'settings.local.json')
```

`SessionManager` 没有覆盖 `onPersistAllow`，走的是 core 的缺省
（`agent.ts:225`：`opts.onPersistAllow ?? ((rule) => appendAllowRule(rule))`）。

(b) 比 (a) 严重，因为它是**静默的权限累积**：用户以为自己只是给「这个项目」放行，
实际是给**所有**项目、**永久**放行。而且这个动作在 UI 上叫「总是允许」——
用户对「总是」的合理理解是「在这个项目里总是」。

### 1.3 这条已经被记成了「坑」，但它不是使用注意事项

`CLAUDE.md` 写着「本仓库的配置在管**所有**会话，包括在别的目录里跑的」。
**把权限边界破了记成一条使用须知，是把设计缺陷降级成了文档。**

### 1.4 我没有做的事（说清楚）

**上面全部是源码层证据，我没有起真 daemon 跑一次跨项目复现。**
理由：这条链很短且每一环都是无分支的（`loadSettings()` 在签名上就没有根参数），
构造不出「其实会跟随会话」的可能性。但这仍然意味着 —— 如果评审认为需要一次真跑，
那应该在动手前补上，而不是事后。

## 二、方案

### 2.1 难点不在改代码，在「哪些配置属于会话、哪些属于 daemon」

`loadSettings()` 全仓 8 个调用点（`grep -rn "loadSettings(" --include=*.ts`），
它们的**语义归属不同**：

| 调用点 | 归属 | 理由 |
|---|---|---|
| `createSession.ts:80` | **会话** | permissions / model / systemPrompt / skills 都该跟着项目走 |
| `agent.ts` 的 `appendAllowRule` 缺省 | **会话** | 「总是允许」必须写回**这个项目** |
| `http/server.ts` 两处（/api/models、PUT /api/model） | **待定** | 无 sessionId 的路由，见 2.3 |
| `startServer.ts` 五处 | **daemon** | MCP server 列表、hostPolicy、imageClient —— 进程级设施 |
| `McpService.ts` / `VoiceService.ts` | **daemon** | 同上 |

**一刀切「全部跟会话」是错的**：MCP server 是 daemon 起的进程，一个 daemon 服务多个项目时
不可能每个会话一套。

### 2.2 做法：`loadSettings({ root })` + 会话侧显式传自己的 root

1. `findProjectRoot(from?: string)` 增加起点参数，缺省仍是 `cwd()`（不动既有调用）。
2. `loadSettings(opts)` 增加 `root?: string`；缺省行为**完全不变**。
3. `createSession` 传 `root: cwd`（会话自己的目录）。
4. `SessionManager` 显式提供 `onPersistAllow`，写回**会话** root 下的
   `.zuse/settings.local.json`。
5. `startServer` / MCP / Voice 那几处**不动** —— 它们本来就是 daemon 级。

这样「会话级」和「daemon 级」在代码里变成两种显式的调用形态，而不是靠
「反正都读同一份」蒙混过去。

### 2.3 需要拍板的一点：无 sessionId 的路由怎么办

`/api/models`、`PUT /api/model`（`server.ts:1063`、`1095`）现在每请求现读 daemon 配置。
一个 daemon 服务多个项目根之后，「当前项目的模型列表」没有唯一答案。

三个选项：
- **A. 保持 daemon 根语义**（模型/provider 是 daemon 级设施）。代价：某项目在自己配置里
  加的 provider 不出现在列表里。
- **B. 加 sessionId 参数**。代价：前端要改调用点；无会话时（首屏）仍需一个缺省。
- **C. 取所有活跃会话 root 的并集**。代价：语义含混，不推荐。

**我倾向 A**：provider 里放的是 API key 和 endpoint，本来就更像机器级配置而不是项目级。
但这一条请评审明确拍。

### 2.4 兼容性：会不会把现有用户的配置「弄丢」

会。今天所有会话都读 zuse 项目那份；改完之后，在别的目录开的会话会改读那个目录的配置
（多半不存在 → 全局默认）。**用户会觉得「我的设置没了」。**

缓解：会话启动时若 `root !== daemonRoot` 且会话 root 下没有任何 `.zuse/settings*`，
在启动日志/首条系统消息里说明一句「本会话使用 <root> 的配置（未找到项目配置，用全局默认）」。
**不做静默回退到 daemon 配置** —— 那等于没修。

## 三、测试计划（TDD）

1. `findProjectRoot(from)`：给定起点，向上找到含 `pnpm-workspace.yaml` 的目录；找不到返回起点。
2. `loadSettings({ root })`：两个临时目录各放一份不同的 `.zuse/settings.json`，
   断言按 root 读到各自那份。
3. `loadSettings()` **不传 root 时行为与改动前逐字段一致**（防回归）。
4. **跨项目隔离**：项目 A 的配置里 `deny: ["Bash(echo *)"]`，项目 B 没有；
   以 B 为 root 的会话对 `echo hi` 的裁决不是 deny；以 A 为 root 的是 deny。
5. **写回落到会话 root**：`appendAllowRule` 经 SessionManager 的 `onPersistAllow`
   写进会话 root 的 `.zuse/settings.local.json`，而**不是** daemon root 的那份
   —— 断言 daemon root 的文件**内容未变**（这条是本次的核心，必须直接断言「没被写」）。
6. daemon 级调用点（MCP / voice / hostPolicy）仍读 daemon root。

**变异验证**：把 `createSession` 传的 root 改回不传 → 第 4、5 条必须红。

**真跑验证**：起真 daemon（cwd = zuse 仓库），用 API 建一个 cwd 指向临时项目的会话，
该临时项目配置里写 `deny: ["Bash(*)"]`，真发一条 Bash 调用 —— 必须被拒。
再点一次「总是允许」，检查规则落在临时项目而不是 zuse 仓库。

## 四、代价汇总

- 行为变化：跨项目会话不再继承 zuse 仓库的配置（这正是修复本身）。
- 8 个调用点要逐个判定归属，判错的后果是「某项设施变成每会话一份」或反之。
- 无 sessionId 路由的语义要拍板（2.3）。
- 用户可感知的「设置没了」，需要一条明确提示。
