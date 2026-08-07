# 权限规则路径匹配：cwd 逃逸漏洞修复

状态：已实现（经独立子代理评审，评审提出的 3 条必修均已修并加测）
影响文件：`packages/core/src/permission.ts`、`packages/core/src/tool.ts`、
`packages/tools/src/{glob,agent-tool,webfetch,lsp/install}.ts`

## 一、实测事实（全部来自实跑，命令与输出见下）

复现脚本（tsx，直接 import `packages/core/src/permission.ts`），`cwd = 'E:/ai-study/test'`：

```
true  | Write(./**)                | C:/Users/nhn/.ssh/id_rsa       | rel= C:/Users/nhn/.ssh/id_rsa
true  | Read(./**)                 | C:/Users/nhn/.ssh/id_rsa       | rel= C:/Users/nhn/.ssh/id_rsa
true  | Write(./**)                | E:/other-project/x.txt         | rel= ../../other-project/x.txt
true  | Read(./**)                 | ../../secret.txt               | rel= ../../secret.txt
true  | Read(**)                   | C:/Windows/System32/config/SAM | rel= C:/Windows/System32/config/SAM
false | Read(src/**)               | C:/Users/nhn/.ssh/id_rsa       | rel= C:/Users/nhn/.ssh/id_rsa
false | Read(src/**)               | ../../etc/passwd               | rel= ../../etc/passwd
true  | Read(./**)                 | /etc/passwd (cwd=/repo)        | rel= ../etc/passwd
false | Read(E:/secrets/**)        | E:/secrets/k.txt               | rel= ../../secrets/k.txt
true  | Read(C:/Users/nhn/.ssh/**) | C:/Users/nhn/.ssh/id_rsa       | rel= C:/Users/nhn/.ssh/id_rsa
false | Read(E:/ai-study/test/**)  | E:/ai-study/test/a.ts          | rel= a.ts
false | Read(/etc/**)              | /etc/passwd                    | rel= ../../etc/passwd
false | Read(~/.ssh/**)            | C:/Users/nhn/.ssh/id_rsa       | rel= C:/Users/nhn/.ssh/id_rsa
```

结论（三个**互相独立**的缺陷）：

1. **P0 逃逸**：以 `**` 开头（或剥掉 `./` 后以 `**` 开头）的相对规则编译成 `^.*$`，
   而比对对象是 `relative(cwd, abs)`。于是 `../../x`、跨盘绝对路径统统命中。
   一条读起来「仅限本项目」的规则实际放行整个文件系统。
   `src/**` 编译成 `^src\/.*$`，**不受影响** —— 问题特定于首段是 `**` 的模式。
2. **P1 绝对路径规则大半失效**：永远拿 `rel` 去比。同盘时 `rel` 是相对路径 →
   `Read(E:/secrets/**)` 匹配不上自己指的文件；跨盘时 `relative()` 返回绝对路径 →
   `Read(C:/…/**)` **碰巧**能匹配。同一条规则的行为取决于盘符，是纯粹的意外。
3. **P1 `~` 规则是空规则**：`~` 不展开，`Read(~/.ssh/**)` 恒不命中。
   而 `packages/tools/src/builtin-skills.ts:60` 的内置文档正拿它当范例教用户写 deny。

三者叠加出真实攻击路径：用户按内置文档写 `deny: ["Read(~/.ssh/**)"]`（不生效），
再写 `allow: ["Read(./**)"]`（越权全盘）→ 模型静默读走 SSH 私钥。
本仓库 `.zuse/settings.local.jsonc:53-54` 现有 `Write(./**)` / `Edit(./**)`，
即当前**任意路径写文件都不弹框**。

补充实测：
- `resolvePath()`（`packages/core/src/tool.ts:21`）**不展开 `~`**，Read/Write/Edit 实际打开的是
  `cwd/~/…`。所以修复**不能**在目标路径侧展开 `~` —— 那会让权限判定与真实打开的文件不一致。
- 内置默认规则表（`DEFAULT_ALLOW_RULES` / `DEFAULT_DENY_RULES`，`settings.ts:47/74`）不含任何
  路径规则，故本修复不改变开箱默认行为。
- `matchPath` / `globToRegExp` 是模块私有，唯一入口是 `matchesRule`；全仓库除
  `permission.ts` 自身与其单测外无其它调用点。
- `matchesRule` 把**所有非 Bash 工具**送进 `matchPath`，包括 WebFetch 的主机名、
  Agent 的描述文本、Glob 的模式串、LspInstall 的语言 id —— 它们不是路径，修复必须保持其行为。

## 二、修复方案

`matchPath` 改为**按规则（spec）的形态决定比对基准**，而不是永远拿 `rel` 比：

| spec 形态 | 比对基准 | 额外约束 |
|---|---|---|
| `~` / `~/…` | 展开 home 后的**绝对 posix 路径** | — |
| 绝对（`/x`、`C:/x`、`C:\x`、`//host/share`） | 目标的**绝对 posix 路径** | win32 上无盘符的 `/x` 补上 cwd 的盘符（否则恒不命中） |
| 其余（相对，含 `./` 前缀） | `relative(cwd, abs)` 的 posix 形式 | **目标必须在 cwd 内**：`rel === '..'`、`rel` 以 `../` 开头、或 `rel` 本身是绝对路径（跨盘）→ 直接不匹配 |

目标路径一律走 `resolve(cwd, rawPath)`（而不是 `isAbsolute(raw) ? raw : resolve(...)`）：
`resolve` 会规整掉 `.` / `..` 段。少了这步，绝对规则那条分支上
`deny: Read(/etc/passwd)` 能被 `/etc/./passwd` 绕过 —— 相对分支的 `relative()` 自带规整，
绝对分支没有。`cwd` 本身也 resolve 一遍，避免相对 cwd 让围栏锚错目录。

配套：spec 里的 `\` 归一成 `/`（Windows 用户会写 `C:\Users\**`；现行实现把 `\` 当字面量转义，
该写法恒不命中，是同一类静默失效）。`globToRegExp` 本身不动 —— `**` 仍能匹配零级目录、
`*` 仍不跨 `/`；Bash 走 `matchCommand`，完全不受影响。

判定「绝对」用自写正则 `/^(?:[A-Za-z]:)?[/]/`，不用 `node:path` 的 `isAbsolute` ——
后者在 posix 上不认 `C:/x`，会让同一份配置在 Windows/Linux 上语义分叉。

## 三、取舍

**更简单的做法有没有？**

- 方案 B「只把 `^.*$` 改成不匹配 `..`」：改 `globToRegExp` 让 `**` 编译成
  `(?!\.\.)[^:]*` 之类。代价：治标；`Read(**/x)`、`Read(*/../..)` 之类仍能绕；
  且完全没修 P1/P2（绝对路径规则、`~` 规则照旧失效）。**不选**。
- 方案 C「一律拿绝对路径比对」：把相对 spec 先 `resolve(cwd, spec)` 成绝对再编译。
  语义上和本方案等价且更统一，但 **会改坏非路径限定符**：`WebFetch(github.com)` 会被
  resolve 成 `E:/repo/github.com`，而目标 `github.com` 也 resolve 成同一个 —— 恰好还能对上；
  但 `Agent(*)` 会编译成 `^E:\/repo\/[^/]*$`，而描述文本 `anything at all` resolve 后是
  `E:/repo/anything at all`，仍能对上……直到描述里带 `/` 或 `..`。行为难以预测。**不选**。
- 本方案（A）保持「相对 spec ↔ 相对路径」这一层不变，只加**围栏**，对非路径限定符
  零影响（它们 resolve 后必在 cwd 内），是改动面最小的正确修法。

**代价 / 行为变化（必须承认）：**

1. cwd 锚定的 **deny** 规则同样被围栏收窄。`deny: ["Read(**/.env)"]` 修复前会拦
   `../../别人项目/.env`，修复后只拦本项目内的。deny 变窄在安全上是**放松**。
   理由是**可审查性**：同一条 `Read(**/.env)` 在 allow 表里意思是「本项目」、
   在 deny 表里意思是「全宇宙」，没有用户能正确读懂自己的配置。
   给 allow 和 deny 两套语义（fail-closed 不对称）会让规则语言自相矛盾，不采纳。

   **这里确实净损失了一项能力，且没有等价替代**（评审纠正了本节的早期措辞）：
   裸 `Read` 不是替代品 —— 它封掉整个工具，不是「全局 deny 某类文件」；
   绝对路径规则也不是 —— 「deny 任何位置的 `.env`」写不成绝对规则，因为绝对 spec 必须有根。
   接受这个损失，理由是：真正用来护私钥的写法（`~/.ssh/**`、`C:/…/**`）
   **修复后才第一次真正生效**，而 `DEFAULT_DENY_RULES` 实测是空数组，开箱行为不受影响。
2. 依赖「`./**` 顺带放行 cwd 外」的用户配置会开始弹框。见风险评估。
3. 末尾 `/**` 现在连目录本身一起覆盖（`src/**` 也匹配 `src`）。这是为 Grep/Glob 服务的 ——
   它们的限定符就是**搜索根**，不这么改则 `deny: Glob(~/.ssh/**)` 拦不住「根正好是 ~/.ssh」
   的那次搜索。副作用是 allow 侧略微放宽（多覆盖目录路径本身），可接受。

## 三补、评审后追加的修复（评审用实测证据推翻了本文的三处判断）

1. **win32 大小写**：Windows 文件系统大小写不敏感（`C:/Users/nhn/.zuse` 与
   `c:/users/nhn/.zuse` 实测是同一目录），而比对是大小写敏感的 —— `deny: Read(~/.ssh/**)`
   只要模型把路径写成小写就绕过去了。本文「净效果是 deny 能力变强」的论证以此为前提，
   不修则不成立。已在 `matchPath` 里按 `sep === '\\'` 给正则加 `i`。
   已知缺口：macOS 默认 APFS 也不敏感但 `sep` 是 `/`，覆盖不到。
2. **非路径限定符并非「零影响」**（本文原话是错的）：`matchesRule` 把所有非 Bash 工具
   都送进 `matchPath`。加了围栏后，描述为 `../修接口` 的 Agent 调用，用户点「本会话允许」
   追加的会话规则 `Agent(../修接口)` **匹配不上它自己**，于是每轮重新弹框 —— 功能回归。
   已加 `Tool.specifierKind: 'path' | 'opaque'`，把 Agent / WebFetch / LspInstall 标为
   `opaque`，按字面 glob 比、不过路径那套。
3. **Glob 的 `specifierFor` 选错了字段**（与本次修复同族的独立漏洞，早已存在）：
   它返回 `pattern`，而真正决定能读到哪些文件的是 `cwd` 字段。实测
   `{pattern:'**', cwd:'~/.ssh'}` 报给权限层的限定符是 `**`，实际枚举出了家目录的私钥
   文件名，`deny: Glob(~/.ssh/**)` 判定为 `allow`。已改为返回搜索根，与 Grep 对齐。
   `pattern` 内的 `../` 逃不出搜索根（`collect()` 从 base 往下走目录树），故只校验根即完备。

### 已知 non-goal（评审指出，明确不做）

- 匹配是**纯字面**的，不做 `realpath`：符号链接 / junction / 8.3 短名（`C:/PROGRA~1`）
  能绕过围栏。realpath 有 TOCTOU 问题，也不完美，故不做 —— 但「目标必须在 cwd 内」
  应理解为「目标**字面上**在 cwd 内」。
- UNC cwd（`\\srv\sh\proj`）下，无盘符的绝对规则 `/secrets/**` 仍是空规则：
  补盘符的正则 `/^[A-Za-z]:/` 在 UNC 上匹配不到东西。
- posix 上 cwd 里真有个名叫 `C:` 的目录时，目标 `C:/x` 会被误判成绝对路径而拒绝（极罕见）。

## 四、测试计划（TDD，先红后绿）

新增两个 describe，加进 `packages/core/src/permission.test.ts`：

- 逃逸护栏：`./**` / `**` / `**/.env` 对跨盘绝对路径、`../` 相对路径、posix `/etc/passwd` 全部不匹配；
  同时 cwd 内目标、`.`（Grep 默认 path）、`src/**` 正常命中。
- 绝对与 `~` 规则：同盘/跨盘/posix 绝对规则命中且不误伤；反斜杠写法命中；
  `~/.ssh/**` 展开后命中且不误伤 cwd 内文件；`decide()` 层面 deny `~/.ssh/**` 真的拦得住。
- 回归：非路径限定符（WebFetch 主机名、Agent 描述、LspInstall 语言 id、Glob 模式串）行为不变；
  `~` **不在**目标侧展开（与 `resolvePath` 保持一致）。

变异验证：把围栏那一行改坏，确认新测试变红，再用 Edit 精确反向改回。
