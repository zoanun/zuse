# 权限层三个洞:重定向自我提权 / 重定向绕过 deny / 假 readOnly(回溯审计 D7 / D5 / D8)

三条都是「**判据看的东西 ≠ 实际发生的事**」,所以放一份 spec 里一起改。

> **v2 落地状态**:D7 + D8 已落地(含评审的全部修正);**D5 拆出去单独一轮** ——
> 评审列了 6 处连带改动(`redirect:'manual'` 之后 `!res.ok` 会吃掉 3xx、jsdom 的 base URL、
> 相对 `Location`、跳数上限、缓存键、每一跳的 scheme 检查),而且 SSRF 的边界要单独划,
> 塞进这一轮会把「只删/只改了该改的」这个门禁冲垮。

## 零、v2:评审推翻的三处 + 我自己实测推翻的一处

**评审推翻:**

1. **我的 D7 修法根本没堵住 headline 威胁。** 本机实配就有 `Write(./**)`,而
   `.zuse/settings.local.jsonc` 落在 cwd 内 —— **根本不需要 Bash 重定向**就能把
   `defaultMode` 改成 `bypass`。重定向判定只是那个后果的**一条**入口。
2. **重定向检测漏四种形态**:`&>f`、`1>f`、`2>f`、`>&f` 全都是真的在写文件,
   而 `bash-security.ts` 现成的那个正则 `/(?:^|[^>&0-9])>(?![&(])/` **一个都看不见**
   （还会把转义的 `echo a \> b` 误报）。`echo x 1> ~/.ssh/authorized_keys` 就是那条 PoC
   的一比一等价替换。照抄那个正则等于什么都没修。
3. **`Bash(*)` 用户会被淹**。`git log > /tmp/l`、`pnpm build > build.log 2>&1` 太常见,
   而 `bash-security.ts` 的文件头已经论证过一次这类噪音不可接受。→ `Bash(*)` 豁免,
   `> /dev/null` 豁免。
4. 另外两条事实错误:我写的测试点里 `grep '>' f`、`sort < f` **今天就是 ask**
   （那两个命令根本不在默认 allow 表里）;Memory 有**五**个 action 不是四个。

**我自己实测推翻的一处(比上面更关键):**

**内置 `ask` 压不过用户的 `allow`。** `decide` 里 allow 是第 4 步、ask 是第 5 步。
我原本把配置文件放进 `DEFAULT_ASK_RULES`,实测被 `Write(./**)` 直接压过 ——
「防止自我提权」在真实配置下**一次都不会生效**。

→ 改成 **`DEFAULT_DENY_RULES`**(第 2 步,压过一切,含 bypass 档)。
这是那段「deny 刻意为空」论证的**唯一例外**,理由写在常量旁边:那三条讲的是
「按字符串前缀猜危险 Bash 命令」,而这里是几个确定的文件名 + 路径 glob,一条都不沾。

**代价照实说**:模型从此不能替你改 zuse 自己的配置,包括「帮我把这个 MCP server
加进去」这种正当请求 —— 它会拿到「这是硬性护栏,请让用户自己改」的明确回执。
**管着 agent 的那个文件,不该由 agent 来写。**

### 本机真实配置下的实测(修完)

```
① 自我提权的两条路
  ask    Bash(*)                        Bash: echo … > .zuse/settings.local.jsonc
  deny   Write(.zuse/settings*.json*)   Write: .zuse/settings.local.jsonc
② 日常命令不该被打死
  allow  echo hi / ls -la / cat package.json / ls a 2>/dev/null
③ Memory 的读写分档
  ask    Memory(save) / Memory(delete)      allow  search / recall / list
④ 正常写文件不受影响
  allow  Write(./**)                    Write: packages/core/src/a.ts
```

### 这条修法**挡不住**什么(照实写,别留虚假的安全感)

- `echo x | tee f` —— `tee` 不在默认表,今天靠「没规则覆盖」挡住;
  **用户一旦 allow 了 `Bash(tee *)` 就全线洞开**,而重定向判定对它无效。
- `>&file`(fd 复制语法写到文件名,极冷门)。
- 命令替换 `$(…)` / 反引号 / 进程替换 `>(…)` —— 由 `hasUnanalyzableShell` 与
  `bash-security` 的 block 档挡,不归这里。

## 一、D7:纯默认配置就能自我拆护栏 —— 比审计写的还糟

### 实测(真 `decide` + 真 `loadSettings` 的默认 allow 表)

```
allow  echo '{"permissions":{"defaultMode":"bypass"}}' > .zuse/settings.local.jsonc
allow  echo x >> ~/.ssh/authorized_keys
allow  cat /etc/passwd > /tmp/leak
allow  echo hi
```

**全部 `matched=-`** —— 不是命中了某条 allow 规则,而是走了「逐子命令全覆盖」那条路:
`splitBashCommand` 不把 `>` 当分隔符(它本来也不是),于是整条命令是**一个**子命令、
以 `echo ` 开头,被 `Bash(echo *)` 前缀覆盖 → 视为「全覆盖」→ 直接 allow,不弹框。

第一条的后果是**护栏自己拆自己**:把 `defaultMode` 改成 `bypass` 之后,
所有 deny/ask 从下一个会话起全部失效。

### 病根

默认 allow 表(`ls / pwd / cat / echo / which / head / tail / wc`)是按
「**这些命令只读**」挑的。**而一个重定向就把其中任何一条变成写。**
判据看的是命令名,实际发生的是写盘。

### 修法:带**文件重定向**的子命令,不能被前缀规则「覆盖」

- 只针对**覆盖**这条路(`bashCoveredBy` 的逐子命令前缀匹配)。
- **精确规则仍然生效**:用户显式写 `Bash(echo x > /tmp/a)` 是他自己认了这条命令,
  该允许。这是「用户显式声明」与「批发式前缀放行」的区别。
- 只认**写向文件**的重定向(`>`、`>>`)。`2>&1`、`>&2` 这种指向 fd 的不算 ——
  它们不产生新的写入面;`<`(读入)也不算。
- 引号内、转义后的 `>` 不算(`echo "a > b"`、`grep '>' f`)。
  `splitBashCommand` 已经有一套引号/转义状态机,复用同一套扫描,**不另写一份** ——
  两套扫描器对同一条命令有两种解释,本轮刚修过一次(`af1e600`)。

### 代价

`echo hi > /tmp/x` 这类无害的重定向从此在 default 档要弹一次框。**这是故意的**:
默认 allow 表的前提是「只读」,重定向违反了那个前提,弹框正是它该有的样子。
嫌烦的人可以自己加一条精确 allow 或者用 Write 工具。

## 二、D5:WebFetch 跟随重定向,限定符只看第一跳

`webfetch.ts` 用 `redirect: 'follow'`,而权限判定发生在**发请求之前**、只看输入 URL。
于是 `deny: WebFetch(127.0.0.1)` 被一个 302 绕过,**而且输出里回显的还是原始 URL**,
人审看不出它去过哪。可以打到 zuse 自己的 API、云元数据地址(169.254.169.254)。

### 修法:手动跟随 + 每一跳都过闸

`redirect: 'manual'`,自己跟随(上限沿用现有的跳数上限,没有就设 5),
**每一跳的 URL 都要再过一次权限判定**。

判定要经 `ToolContext` 注入一个回调(工具层拿不到 settings,也不该拿):

```ts
interface ToolContext {
  /** 二次判定：工具在运行中发现自己要碰一个新的目标时调它。拒绝就抛/返回错误。 */
  checkSpecifier?(toolName: string, specifier: string): Promise<'allow' | 'deny' | 'ask'>
}
```

**不给它就退化成「不跟随跨源重定向」** —— 那是安全的默认,不是静默放行。

### 输出必须写出最终 URL

无论允许与否,输出里要写「经 N 跳到达 X」。今天回显原始 URL 是**误导人审**:
用户看到的地址和实际抓的地址不是一个。

### 代价

- 短链(bit.ly 之类)在没有回调时会被拒。文档要说清,并给出「直接给最终 URL」的出路。
- 多一次判定往返。可忽略。

## 三、D8:Memory 标 `readOnly` 但写的是**未来所有会话的系统提示词**

`memory.ts` 的注释自陈是「有意拉伸」:写入面是 zuse 自有库、不碰用户工作区。
**但同一个文件的工具描述又写着**:

> an index of them (MEMORY.md) is loaded into your system prompt at session start

也就是说 `Memory save` 写的东西会进入**机主此后每一个会话的系统提示词**。
而 `readOnly: true` 让它在 default 档**不弹框**(`decide` 末尾
`tool.readOnly ? 'allow' : 'ask'`)。

**一次提示注入就能把「以后遇到 X 就执行 Y」永久写进机主的所有后续会话。**
这是本轮所有洞里**持续时间最长**的一个 —— 别的洞是一次性的,这个是长期驻留。

### 修法:按 action 分档,不是整个工具翻成非只读

Memory 有 `save` / `delete` / `search` / `recall` 四个 action。
`readOnly` 是工具级静态属性,改成 false 会让 `search`/`recall` 也弹框 —— 噪音换不到安全。

改用**限定符**:给 Memory 加 `specifierFor: (input) => input.action`,
并把 `Memory(save)`、`Memory(delete)` 放进**内置默认 ask 表**。
读的两个 action 照旧静默。

**这需要内置默认 ask 表** —— 今天 `DEFAULT_DENY_RULES` 是空的、也没有默认 ask 表。
加一个 `DEFAULT_ASK_RULES`,并在那里写清楚「为什么这条值得烤进内置」
(理由与 `DEFAULT_DENY_RULES` 为空的三条论证不冲突:那三条讲的是
「按字符串前缀猜危险 Bash 命令是打地鼠」,而这里是**一个确定的工具 + 一个确定的 action**,
不存在等价变体问题)。

### 代价

模型每次要存记忆都会弹一次框。**这是对的** —— 存进去的东西会影响此后所有会话,
那值得看一眼。用户嫌烦可以自己 allow。

## 四、测试点

D7:
1. 默认 allow 表 + default 档下,`echo … > .zuse/settings.local.jsonc` **必须 ask**(不是 allow)。
2. `echo x >> ~/.ssh/authorized_keys`、`cat a > b` 同上。
3. `echo hi`(无重定向)仍然 allow —— 别把默认体验打死。
4. `echo "a > b"`(引号内)、`grep '>' f`、`ls 2>&1`、`sort < f` 仍然 allow。
5. **精确规则仍然生效**:`allow: ['Bash(echo x > /tmp/a)']` 下那条命令 allow。
6. 复合命令:`ls && echo x > f` 必须 ask(逐子命令,第二条带重定向)。

D5:
7. 有 `checkSpecifier` 时,跳到被 deny 的 host 要报错、不发第二次请求。
8. 没有 `checkSpecifier` 时,**跨源**重定向被拒;同源重定向照跟。
9. 输出里含最终 URL 与跳数。

D8:
10. `Memory(save)` 在 default 档 → ask;`Memory(search)` → allow。
11. `specifierFor` 返回 action;非法 action 不崩。

**变异验证**:①去掉重定向判定 → 第 1 条红;②`DEFAULT_ASK_RULES` 清空 → 第 10 条红;
③WebFetch 改回 `redirect:'follow'` → 第 7 条红。

## 五、真跑验证

- 真敲 Bash 工具跑 `echo x > /tmp/zz`,看它是不是真的弹框(而不是只看单测)。
- 真起 daemon,让模型存一条记忆,看权限框出不出来。
- WebFetch 打一个真的 302(比如 `http://neverssl.com` 之类),看输出里有没有最终 URL。

## 六、修订记录

- v1(2026-08-14):初稿,交独立子代理评审。
