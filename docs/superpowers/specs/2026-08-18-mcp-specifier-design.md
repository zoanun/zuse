# MCP 工具在路径护栏之外 —— 设计

> 状态：待独立评审。发现者与作者是同一个，**结论不能自己批准自己**。

## 1. 实测事实

`packages/core/src/mcp-registry.ts:128` 的 `buildMcpTool` 返回的 Tool **没有
`specifierFor`，也没有 `specifierKind`**：

```ts
return {
  name: zuseToolName,
  description: scanMcpDescription(...),
  inputSchema: toolDef.inputSchema as JSONSchema,
  async run(input) { ... },
}
```

而 `agent.ts` 取限定符是 `tool.specifierFor?.(tu.input) ?? null`，
`matchesRule` 在 `specifier === null` 且规则带限定符时**直接 return false**。

结论：**任何带限定符的规则对 MCP 工具都不可能命中。** 能写的只有裸
`mcp__server__tool`（全有或全无）。一个 filesystem / git / shell 类的 MCP server
在全自主档下是完全无护栏的写入面 —— 连 Bash 那 23 项安全检查都不过（那是按工具名挂的）。

对照：本轮刚补的 Bash 重定向判定只覆盖 Bash。**别让「Bash 修好了」读起来像
「写入面收口了」。**

## 2. 难点：MCP 的入参是任意 JSON

Bash 的限定符是命令行、Write 的是路径 —— 都有一个天然的「这一次动的是什么」。
MCP 没有：`{ "url": "..." }`、`{ "path": "...", "content": "..." }`、
`{ "query": "...", "limit": 10 }`，形状由 server 自己定。

限定符还要满足两个**互相拉扯**的约束：

1. **可写规则**：用户得写得出 `mcp__fs__write(~/secrets/**)` 这种东西。
2. **可复用**：`allow_session` / `allow_persist` 会把 `工具名(限定符)` 原样落盘。
   限定符要是把整个入参 JSON 序列化进去，那条规则**下一次必然不命中** ——
   等于每次都重新问，而用户以为自己已经允许过了。这比不给限定符更坏。

## 3. 候选

### A. 取「主参数」：按一张公认键名表挑

`path` / `file` / `filename` / `url` / `uri` / `query` / `command` / `pattern` /
`name` —— 按这个顺序找第一个字符串值。

- 收益：对绝大多数真实 MCP server 都能给出**人能看懂、也能写规则**的东西
  （`browser_navigate` → URL；`fs_write` → 路径）。规则可复用（同一目标反复命中）。
- 代价：**是启发式**。server 用了表外的键名（`target` / `src` / `dest`）就退化成
  「没有限定符」。而且只看一个键 —— `{path, content}` 只护住 path 那半边。

### B. 整份入参的紧凑 JSON（截断）

- 收益：不猜，规则可以用通配符匹配任意字段（`mcp__fs__write(*secrets*)`）。
- 代价：**规则不可复用**（第 2 条约束直接违背）；卡片上是一坨 JSON；
  截断之后 glob 语义变得不可预期。

### C. 不给限定符，改在权限层特判 MCP

比如「MCP 工具一律走 ask，除非用户显式 allow 整个工具」。

- 收益：不做任何猜测。
- 代价：这**就是今天的行为**（全有或全无），只是把它写明白。没解决问题。

## 4. 倾向：A，且**把退化说清楚**

理由：第 2 条约束（可复用）把 B 排除了 —— 一条永远不命中的 allow 规则是
「看起来有护栏、实际没有」的最坏形态，本仓已经因为这个形状出过洞
（`parseRule` 不认连字符 → MCP 的 deny 规则静默失效，回溯审计 D6）。

A 的退化必须**显式可见**，不能静默：
- 挑不出主参数时，`specifierFor` 返回 `null`（= 今天的行为），
  **并且启动体检要报一句**：「`mcp__x__y` 认不出主参数，带限定符的规则对它不生效」。
  本仓已有 `validateRules` 的启动体检通路（D6 那轮加的），挂在那里。
- `specifierKind` 用 `'opaque'`：这些值不保证是路径，不该过 cwd 围栏与 realpath。

## 5. 待评审的问题

1. 键名表该收哪些？顺序重要吗（`{path, url}` 同时存在时取谁）？
2. `{path, content}` 只护 path 那半边 —— 可接受吗？还是该把「所有字符串值拼起来」
   作为限定符（那会同时踩到 B 的两个代价）？
3. `specifierKind: 'opaque'` 对 filesystem 类 MCP 是不是错的？
   路径语义（`~` 展开、cwd 围栏、大小写）在那里恰恰是想要的。
   但 opaque 与 path 只能二选一，而同一个工具名下两种都可能。
4. 启动体检报「认不出主参数」会不会太吵？本机 15 个 MCP 工具里会报几条？
   **请实测**（daemon 在 127.0.0.1:4180 跑着，`GET /api/mcp` 能拿到工具清单与入参 schema）。
5. 有没有第四条路是我没想到的？
