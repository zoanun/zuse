# Zuse 输出整形/截断(Feedback Shaping)设计 —— Phase 9

日期:2026-06-12
状态:已定
对应 roadmap:Phase 9(输出整形/截断)。Phase 8 管「失败怎么说」,本期管「大输出怎么塑形成信号」。
源码参考:OpenCode `tool/truncate.ts`(按预算截断 + 溢出落盘)、`tool/truncation-dir.ts`。

## 1. 现状审计(2026-06-12)

| 截断点 | 现状策略 | 判定 |
| --- | --- | --- |
| Read | 行窗口 + 100k 字符上限,行边界停,截断尾给续读 offset | ✅ 可寻址续读,不动 |
| Grep | head_limit/offset 分页(缺省 250,0 解除但有 5000 安全上限) | ✅ 可寻址续读,不动 |
| Glob | 内部全量收集排序,回 mtime 最新 200 条 + 真实总数注记 | ✅ 已塑形,不动 |
| Bash | 流式累加到 30k **即丢弃其后所有输出**(只留头) | ❌ 尾部最值钱(测试失败摘要、报错堆栈都在尾),恰恰全丢 |
| WebFetch | 50k 头部硬切,中文注记,无续读手段 | ❌ 标记自成一派;截掉的部分拿不回 |

## 2. 核心决策:归一是「同一策略族」,不是「同一个函数」

roadmap 说「与 Read/Grep 归一到同一套塑形逻辑」。审计后精确化:大输出分两类,塑形手段本质不同——

- **可寻址输出**(文件内容、匹配列表):有天然坐标(行号/条目序),正确塑形是**分页 + 续读指引**。Read/Grep/Glob 已按此实现,保持。
- **一次性 blob**(Bash stdout、WebFetch 正文):无坐标可寻址,重跑代价高(命令有副作用/网络往返)。正确塑形是 **head + tail + 全量落盘**:首尾是信号密度最高的两端,中段省略;完整输出存文件,模型需要时用 Read/Grep(自带分页)去查——把「不可寻址」转化成「可寻址」。

归一的落点 = 新共享模块 `packages/tools/src/truncate.ts`,blob 类工具共用;标记格式全仓统一为 `[truncated: …]` 风格(WebFetch 的中文注记一并换掉,observation 读者是模型,与其他工具的英文保持一致)。

## 3. `truncate.ts` 模块设计

### 3.1 纯函数 `shapeHeadTail`(整段文本,WebFetch 用)

```ts
interface ShapeOptions {
  headChars: number   // 头部预算
  tailChars: number   // 尾部预算(0 = 只留头,适合正文截断)
}
function shapeHeadTail(text: string, opts: ShapeOptions): { body: string; truncated: boolean }
```

- `text.length <= headChars + tailChars` → 原样返回,`truncated: false`。
- 超出 → `head + marker + tail`,头尾都在**行边界**收口(找预算内最后一个 `\n`;整段无换行则按字符切,不为找行边界牺牲超过预算 20% 的内容)。
- marker:`\n…[truncated: output was N chars / M lines; showing first X and last Y chars]\n`(tail=0 时省略 last 段)。

### 3.2 流式 `StreamShaper`(Bash 用)

```ts
interface StreamShaperOptions extends ShapeOptions {
  spill?: { dir: string; prefix: string }  // 全量落盘(可选);dir 可注入便于测试
}
class StreamShaper {
  append(text: string): void
  finalize(): { body: string; truncated: boolean; totalChars: number; spillPath: string | null }
}
```

- **内存恒有界**(保持现状的核心优点):head 缓冲只收前 `headChars`;tail 用「字符串环形缓冲」`tail = (tail + text).slice(-tailChars)` 只留最后 `tailChars`;总量计数器照常累加。刷屏命令(`yes`、cat 大文件)不会撑爆进程。
- **全量落盘(spill)**:输出总量首次越过 `headChars` 时懒创建 `<dir>/<prefix>-<ts>-<rand>.txt`,先写入已积累的全部内容,此后每个 chunk 写穿(writeSync)。于是 spill 文件 = 完整输出。必须在 `headChars` 这一刻开(而非 head+tail 越界时)——再晚 tail 环已开始丢字符,落盘就不全了。
- **finalize**:
  - 总量 ≤ head+tail → body = 全文,删掉提前开的 spill 文件(白开了,无害),`truncated: false`。
  - 超出 → `head + marker + tail`,marker 带落盘路径:
    `\n…[truncated: output was N chars; showing first X and last Y chars. Full output: <path> — use Read or Grep (they paginate) to inspect it]\n`
  - spill 创建/写入失败(磁盘满、权限)→ 优雅降级:照常截断,marker 不带路径。塑形不能因落盘挂掉。

### 3.3 预算分配(Bash)

总预算维持 30k 不变,**尾重头轻:head 10k + tail 20k**。理由:coding agent 的 Bash 高频场景是跑测试/构建,失败摘要、报错堆栈、"N failed" 都在尾部;头部留 10k 够看到命令回显与早期输出。

### 3.4 落盘目录与清理

- 位置:`~/.zuse/tool-output/`(沿用 `~/.zuse` 配置目录约定,与 sessions/shell-snapshots 平级)。
- v1 **不做自动清理**:文件仅在输出>10k 时产生,体积有限;会话结束后它们仍可能被用户翻看。记一条后续优化(启动时清 7 天前旧文件),不阻塞本期。

## 4. 各工具接线

- **Bash**:`append` 改为喂 `StreamShaper`(stdout/stderr 仍共享同一个,保持时序混排);`close` 时 `finalize()`,body 后接既有的 exit-code/timeout 标记行(Phase 8 的文案不变)。`(no output)` 占位保持。
- **WebFetch**:`truncate()` 换成 `shapeHeadTail(text, { headChars: 50_000, tailChars: 0 })`——文章正文头部是信号,尾部多为页脚杂讯,不留尾;中文注记换统一 marker。不落盘(重抓有 15min 缓存,代价低)。
- **Read/Grep/Glob**:不动(§2)。

## 5. 验证(TDD)

- `truncate.test.ts` 单测:不超预算原样透传;head/tail 行边界收口;无换行长行的字符切退路;marker 含总量与首尾尺寸;StreamShaper 跨 chunk 累计正确;spill 文件内容 = 完整输出;未触顶时 spill 文件被删;spill 失败(不可写目录)优雅降级。
- `bash.test.ts` 集成:node 产出 >30k 且首尾各有标志行的输出 → 断言头标志在、尾标志在、marker 在、spill 文件存在且含中段内容;≤30k 输出无 marker 无文件。
- `webfetch.test.ts`:超长正文 → 统一 marker;原中文注记断言更新。

## 6. 不做(out of scope)

- Read/Grep/Glob 改动——已是正确塑形。
- spill 文件自动清理(记入后续)。
- 「中段摘要」(LLM 总结被省略部分)——重、且 head+tail+落盘已覆盖 95% 场景。
- Bash 后台执行/输出轮询(`run_in_background`)——归多 Agent/调度的后续 phase。
