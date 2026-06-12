# Zuse 会话管理与上下文压缩设计 —— Phase 10

日期:2026-06-12
状态:已定
对应 roadmap:Phase 10(会话管理与上下文压缩)。
源码参考:CC `services/compact/`、OpenCode `session/compaction.ts`(preserve recent / PRUNE_PROTECT)、`session/overflow.ts`(窗口占用 = input+output+cache reads)。

两块独立交付:**A. 会话管理**(持久化/续接),**B. 上下文压缩**(窗口治理)。

## A. 会话管理

### A1. 现状与差距

现状:`~/.zuse/sessions/<name>.json` 扁平命名存档,仅手动 `/save <名>` / `/load <名>`。
差距:不按 cwd 分组(不同项目的会话混在一起)、无自动保存(崩溃/误关全丢)、无
`--continue`/`--resume`(重开终端无法接着聊)。

### A2. 存储布局

```
~/.zuse/sessions/
  <name>.json                    # 命名存档(/save /load),原样保留
  auto/<cwd-slug>/<session-id>.json   # 自动会话,按 cwd 分组
```

- `cwd-slug`:cwd 全路径中 `[^a-zA-Z0-9]` → `-`(对齐 CC 的 projects 目录编码;
  Windows 盘符冒号、反斜杠都被归一)。
- `session-id`:启动时生成 `<yyyymmdd-hhmmss>-<rand4>`,整个进程生命周期不变。
- 命名存档与自动会话**分树**:`auto/` 子目录天然避开 `safeName` 的同名碰撞,
  /save 语义零变化。

### A3. 文件格式(SessionRecord v2)

```ts
interface SessionRecord {
  version: 2
  cwd: string          // 原始 cwd(slug 有损,真实路径存在记录里)
  createdAt: string    // ISO-8601
  updatedAt: string
  messages: Message[]
  totalUsage: Usage
}
```

- 命名存档仍写 `ConversationSnapshot v1`(不动老格式,/load 读 v1);自动会话写 v2。
- 读 v2 失败(损坏 JSON)→ 列表里跳过该文件,不让一个坏文件毁掉 --continue。

### A4. 自动保存

- 时机:**每个回合提交后**(useConversation 的 for-await 结束、读取 totalUsage 的
  同一处)fire-and-forget 异步写,失败静默(autosave 不能打断对话)。
- 空会话(0 条消息)不写文件——避免每次打开 zuse 又立即退出都留一个空壳。
- `/clear` 后换**新 session-id**:清掉的历史保留在旧文件里(还能 --resume 回来),
  新对话写新文件。
- `/load <名>` 载入命名存档后,后续回合**继续写当前自动会话**(命名存档是只读快照,
  autosave 始终面向 auto 树)。

### A5. 续接入口

- `zuse --continue`(或 `-c`):载入**本 cwd** 最新(updatedAt 最大)的自动会话。无
  会话则提示后照常开新会话。
- `zuse --resume <序号|id>`:载入本 cwd 指定会话;序号 = `/resume` 列表序(1 最新)。
- `/resume`(无参):在会话内列出本 cwd 最近 10 个自动会话(序号 / 时间 / 首条用户
  消息截断 40 字 / 消息数);`/resume <序号>` 载入。
- **有意不做启动交互式选择器**(CC 的 --resume 全屏列表):需要新 overlay 组件与
  App 启动态机,收益对学习项目不成比例;`/resume` 列表 + 序号已覆盖该工作流。记入
  Phase 7 系 UI 打磨 backlog。
- 载入自动会话后 session-id **沿用被载入会话的 id**(同一条会话延续写同一文件),
  这是 --continue 的语义本体;与 /load 命名存档(只读快照、不接管 id)不同。

### A6. 落点

- `sessionStore.ts` 扩展:`autosaveSession` / `listAutoSessions` / `loadAutoSession`
  (slug、列表排序、容错都在这层,纯 Node 可单测)。
- `useConversation`:新增 `onTurnCommitted` 内部 autosave 调用 + `adoptSession(id)`;
  `clear` 换新 id。
- `index.tsx`:argv 解析(--continue/-c、--resume),把初始 Conversation(或 null)
  传给 App → useConversation 接受 `initial?: { conversation, sessionId }`。

## B. 上下文压缩

### B1. 窗口占用与溢出判定

- 真实占用已有:`message-stop` 的 `input_tokens + cache_read_input_tokens`(两家
  client 已归一,footer 在用)——**不估算,用上一回合实测值**(OpenCode 同思路)。
- 窗口大小(2026-06-12 修订,模型级配置):`models` 条目放宽为
  `string | { name, contextWindow? }`,查找顺序**模型级 → provider 级
  `contextWindow` → 全局缺省 512_000**。改模型级的理由:窗口是模型属性而非
  provider 属性(DashScope 下 qwen3.7-max 1M 与小模型 128k 并存),拆 provider
  条目会重复 apiKey、切断 failover 同 provider 降级链。缺省取 512k 依据 2026-06
  实测主流(Claude 主线/GPT/Qwen3.7-Max/DeepSeek V4 均 1M 档);**不对称风险**:
  仍在用的小窗口模型(DeepSeek V3 128k、本地 Ollama)必须显式声明,否则压缩
  阈值永远等不到、窗口先炸。归一化 helper `modelNames()` 供所有消费 models
  名单的代码(picker/failover/校验)共用。
- 阈值:占用 > `contextWindow * 0.8` 触发自动压缩(下回合发送前);`/compact` 手动
  随时可触发。

### B2. 压缩策略 = keep recent + summarize middle

把账本切成两段:**摘要段**(老历史)+ **保留段**(最近的完整回合)。

- **切点必须落在「真实用户回合」边界**:`messages[i].role === 'user'` 且首块是
  `text`(不是 tool_result)。在 tool_use/tool_result 对中间切会造成孤儿 tool 块,
  下一次请求直接被 API 拒(两家协议都要求配对)。
- 保留段 = 最近 **2 个**真实用户回合(及其全部 tool 往返)。摘要段不足 2 个回合时
  拒绝压缩(没东西可压)。
- 摘要段交当前模型生成结构化摘要(单独 `sendMessages` 调用,无工具、收紧
  max_tokens;摘要 prompt 要求保留:任务目标与当前状态、关键决策与理由、改过的
  文件清单、未完成事项、用户明确的约束)。
- 压缩后账本 = `[user: "[之前对话的摘要] …"]` + 保留段。totalUsage 累计值**不清零**
  (它是成本账,不是窗口账)。
- 压缩本身的失败(摘要调用报错/被中断)→ 原账本不动,提示用户,绝不半压。

### B3. 接线

- `packages/core/src/compaction.ts`:纯逻辑 `findCompactionCut(messages, keepTurns)`
  + `buildSummaryRequest(messages)` + `applyCompaction(conv, summaryText, cutIndex)`,
  全部可用 fake 数据单测,不碰网络。
- `useConversation`:`compact()` 回调(/compact 调用);sendMessage 开头检查
  `contextTokens > 0.8 * window` → 先压缩再发送(压缩期间 footer 显示「压缩中…」,
  以 system 气泡通知结果:压前/压后 token)。
- 自动压缩**不弹确认**:0.8 阈值留了余量,且 /clear、/resume 都可逃生;弹框会打断
  无人值守的长任务(与 CC AutoCompact 行为一致)。

### B4. 验证(TDD)

- 切点:tool 往返中间不可切;恰好 2 回合拒压;摘要段含 N-2 回合。
- applyCompaction:压后首条是摘要 user 消息、保留段逐字节相等、usage 不清零。
- sessionStore:slug 编码(Windows 路径)、列表按 updatedAt 倒序、坏文件跳过、
  空会话不落盘、/clear 换 id 后旧文件不被覆写。
- 触发:fake client 注入 usage 把占用顶过阈值 → 断言下一次 sendMessage 先发生压缩。

## 不做(out of scope)

- 启动交互式会话选择器(→ UI backlog,见 A5)。
- MicroCompact(只裁工具结果保留正文)、多级压缩——v1 一档全量摘要够用。
- 跨 cwd 的全局会话搜索。
- 压缩用便宜小模型(配置面扩大;v1 用当前模型,贵但简单正确)。
