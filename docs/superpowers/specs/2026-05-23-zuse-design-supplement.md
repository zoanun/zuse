# Zuse 设计补充建议

**日期**: 2026-05-23
**来源**: Harness Engineering课程内容分析
**用途**: 对2026-05-21-zuse-design.md的补充，按Phase进度逐步纳入

---

## 一、故障模式防御矩阵（建议在Phase 0完成后加入）

课程Part 1提供了系统性的Agent故障模式框架，这是设计决策的重要依据：

| 故障模式       | 描述                                  | Zuse应对措施                                                       | 实现Phase    |
| -------------- | ------------------------------------- | ------------------------------------------------------------------ | ------------ |
| ① 循环失控     | tool_use无限循环，agent不停止         | max_turns参数 + 用户Ctrl+C中断(signal)                             | Phase 3.5    |
| ② Context溢出  | messages超出token限制                 | token计数 + 压缩策略 + budget分配                                  | Phase 2.4, 8 |
| ③ Cache miss   | prompt结构不稳定导致Anthropic缓存失效 | system prompt固定结构 + tool描述稳定 + cache_control标记           | Phase 3, 6   |
| ④ Tool错误吞   | 工具执行失败但agent继续假装成功       | 错误结果显式返回 + is_error:true标记                               | Phase 3.8    |
| ⑤ 状态丢失     | 会话中断后之前工作信息丢失            | session持久化(~/.zuse/sessions/) + 每轮自动保存                    | Phase 8      |
| ⑥ 缺权限闸     | 任意工具可执行，Bash可能rm -rf        | PermissionManager pre-check + 权限模式(default/acceptEdits/bypass) | Phase 5      |
| ⑦ 缺自动化评审 | 无质量把关，生成代码可能有问题        | Generator-Evaluator模式 + /review命令（未来）                      | Phase 10+    |
| ⑧ 成本失控     | API调用无限制，token消耗不可控        | usage统计 + 模型选择(haiku省钱) + 预算提醒                         | Phase 2.4    |

---

## 二、Phase 3.5 Agent Loop 补充（建议在Phase 3设计时加入）

当前设计文档的伪代码缺少显式循环限制，需要补充：

### 修改后的Agent Loop伪代码

```
loop (max_turns = 50, current_turn = 0):
  if current_turn >= max_turns:
    emit event { type: "warning", message: "达到最大轮次限制，强制终止" }
    break
  current_turn += 1

  events = modelClient.sendMessages(conversation.messages, registry.list())
  for event in events:
    emit event to UI
    if event.type === "tool_use":
      decision = permissionManager.check(event.tool, event.input)
      if decision === "deny":
        append tool_result(is_error: true, content: "user denied")
        continue
      try:
        result = registry.get(event.name).run(event.input, { signal, cwd })
        conversation.append(assistant_message_with_tool_use)
        conversation.append(user_message_with_tool_result(result))
      except ToolExecutionError as e:
        append tool_result(is_error: true, content: e.message)
    if event.type === "error":
      emit error to UI
      break
  if last response stop_reason === "end_turn":
    break
```

### 补充要点

1. **max_turns**: 默认50，可通过配置调整，防止故障模式①
2. **signal**: AbortSignal传递给每个工具，支持用户Ctrl+C中断
3. **try-except**: 工具执行异常捕获，防止故障模式④

---

## 三、Cache优化策略（建议在Phase 3/6设计时加入）

Anthropic API支持Prompt Caching，合理使用可降低成本和延迟：

### 可缓存部分及标记方式

```typescript
// System prompt（含ZUSE.md内容）
{
  role: "user",
  content: [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }
  ]
}

// Tool definitions（首次发送后缓存90分钟）
{
  tools: registry.list().map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  })),
  // Anthropic SDK会自动缓存tools
}
```

### 实现要点

- **System prompt结构稳定**: 不要每次动态拼接不同内容
- **Tool描述固定**: Phase 3确定后不要频繁修改
- **历史对话缓存**: 多轮连续对话时，之前的messages会被缓存
- **Cache命中监控**: Phase 6时可加入cache_read_tokens统计

---

## 四、Token Budget分配策略（建议在Phase 8设计时加入）

当conversation history增长时，需要明确token预算分配：

### 默认Budget分配（假设200K context window）

| 部分                 | 预算占比     | 说明                     |
| -------------------- | ------------ | ------------------------ |
| System Prompt        | ~15% (~30K)  | 含ZUSE.md、SKILL加载内容 |
| Tool Descriptions    | ~20% (~40K)  | 动态加载，按需激活       |
| Conversation History | ~50% (~100K) | 历史对话，需要压缩管理   |
| Response Buffer      | ~15% (~30K)  | 预留给模型输出           |

### 压缩触发条件与策略

```typescript
interface CompressionPolicy {
  triggerThreshold: number // 例如：history超过80K时触发
  strategies: [
    'keep_recent_n_turns', // 保留最近N轮完整对话
    'summarize_middle', // 中间轮次生成摘要
    'preserve_first_input', // 首轮user input保留（关键背景）
    'preserve_decisions', // 关键决策点标记保留
  ]
}
```

### 压缩实现伪代码

```
function compressHistory(messages: Message[], budget: number): Message[] {
  if (tokenCount(messages) <= budget) return messages

  const recentTurns = messages.slice(-10)  // 保留最近10轮
  const middleMessages = messages.slice(0, -10)

  // 用LLM生成摘要压缩中间部分
  const summary = await model.summarize(middleMessages)

  return [
    { role: "user", content: "历史摘要：" + summary },
    ...recentTurns
  ]
}
```

---

## 五、记忆系统技术细节（建议在Phase 9设计时加入）

当前Phase 9只提到了文件加载，需要补充存储和搜索机制：

### 目录结构设计

```
~/.zuse/
├── SYSTEM.md              # 全局系统提示（跨项目）
├── config.json            # 用户偏好配置
├── sessions/
│   └── {cwd-hash}/        # 按工作目录分组
│       ├── session.json   # 会话元数据
│       └── memory.db      # SQLite + FTS5
└── skills/                # Phase 10+
    └── {skill-name}/
        └── SKILL.md
```

### SQLite表结构（参考Hermes）

```sql
-- 主表：存储完整记忆
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,              -- "user" | "assistant" | "decision" | "note"
  content TEXT,           -- 原始内容
  summary TEXT,           -- LLM生成的摘要（可选）
  importance REAL,        -- 重要度评分（0-1）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_accessed DATETIME,
  embedding BLOB          -- 可选：向量嵌入（Phase 10+）
);

-- FTS5虚拟表：全文搜索
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  summary,
  content='memories',
  content_rowid='id'
);

-- 触发器：自动同步FTS
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary)
  VALUES (new.id, new.content, new.summary);
END;
```

### TypeScript实现库

```bash
pnpm add better-sqlite3 @types/better-sqlite3
```

```typescript
import Database from 'better-sqlite3'

const db = new Database('~/.zuse/sessions/{cwd-hash}/memory.db')

// 全文搜索示例
function searchMemory(query: string): Memory[] {
  const stmt = db.prepare(`
    SELECT m.* FROM memories m
    JOIN memories_fts fts ON m.id = fts.rowid
    WHERE memories_fts MATCH ?
    ORDER BY bm25(memories_fts) DESC
    LIMIT 10
  `)
  return stmt.all(query) as Memory[]
}
```

### Nudge机制（参考Hermes）

每轮对话结束时，自动检查是否需要更新MEMORY.md：

```
if conversation contains important decision or new knowledge:
  emit event { type: "nudge", message: "是否更新项目记忆？" }
  if user confirms:
    append to MEMORY.md or update summary
```

---

## 六、Skills系统格式（建议在Phase 10设计时加入）

参考skill-creator-pro的SKILL.md格式：

### SKILL.md模板

```markdown
---
name: skill-name
description: 触发条件 + 能力描述 + 何时使用
---

# Skill Name

## Goal

[1-2句话描述这个skill解决什么重复问题]

## Workflow

1. 确认输入
2. 分类请求
3. 路由到正确资源
4. 执行最小可行路径
5. 验证输出
6. 报告结果和风险

## Decision Tree

- If A, run `scripts/...`
- If B, read `references/...`
- If C, use `assets/...`

## Constraints

- 不可违反的规则
- 需要确认的情况

## Validation

- 必须检查的内容
- 成功标准
- 首次失败检查点

## Resources

- `scripts/...`: 何时运行
- `references/...`: 何时阅读
- `assets/...`: 何时使用
```

### Skills目录结构

```
~/.zuse/skills/
├── frontend-design/
│   ├── SKILL.md
│   ├── references/
│   │   └── component-patterns.md
│   └── assets/
│       └── component-template.tsx
├── debugging/
│   ├── SKILL.md
│   ├── scripts/
│   │   └ analyze-error.py
│   └── references/
│       └── common-fixes.md
```

### 技能加载机制

```typescript
interface SkillIndex {
  name: string
  description: string
  path: string
  triggers: string[] // 从description提取的关键词
}

// 启动时扫描
function loadSkillsIndex(): SkillIndex[] {
  const skillsDir = path.join(os.homedir(), '.zuse', 'skills')
  return fs
    .readdirSync(skillsDir)
    .filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')))
    .map((name) => {
      const skillMd = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8')
      const frontmatter = parseFrontmatter(skillMd)
      return {
        name: frontmatter.name,
        description: frontmatter.description,
        path: path.join(skillsDir, name),
        triggers: extractTriggers(frontmatter.description),
      }
    })
}

// 匹配时加载完整内容
function loadSkill(skillName: string): Skill {
  const skillPath = path.join(os.homedir(), '.zuse', 'skills', skillName)
  const skillMd = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8')
  return parseSkill(skillMd)
}
```

---

## 七、Verification机制（Phase 10+未来扩展）

Generator-Evaluator模式：生成后自动评审

```typescript
interface VerificationLoop {
  generator: Agent // 主agent，生成内容
  evaluator: Agent // 评审agent，检查质量
  maxIterations: number // 最大迭代次数
  passThreshold: number // 通过阈值（评分）
}

async function verifiedGenerate(prompt: string): string {
  let output = await generator.run(prompt)
  let review = await evaluator.run({ input: prompt, output })

  while (review.score < passThreshold && iterations < maxIterations) {
    output = await generator.run({
      prompt,
      previousOutput: output,
      reviewFeedback: review.feedback,
    })
    review = await evaluator.run({ input: prompt, output })
    iterations++
  }

  return output
}
```

---

## 八、实施路线图补充

根据课程内容，建议调整Phase优先级：

| 原Phase       | 补充内容                       | 课程参考                            |
| ------------- | ------------------------------ | ----------------------------------- |
| Phase 0完成后 | 加入"故障模式防御矩阵"章节     | Part 1 原理与概念                   |
| Phase 3.5     | Agent Loop加max_turns + signal | Part 1 故障模式①                    |
| Phase 3-6     | Cache优化策略                  | Part 4 Hermes                       |
| Phase 8       | Token Budget + 压缩策略        | Part 7 记忆管理 + Part 8 上下文工程 |
| Phase 9       | SQLite + FTS5 + Nudge机制      | Part 4 Hermes + Part 7              |
| Phase 10      | SKILL.md格式 + 技能加载        | Part 6 Agent Skills                 |

---

## 九、TypeScript技术选型补充

| 功能      | Python课程方案        | TypeScript替代方案               |
| --------- | --------------------- | -------------------------------- |
| SQLite    | sqlite3标准库         | better-sqlite3 (同步API，性能好) |
| FTS5      | sqlite3原生支持       | better-sqlite3原生支持           |
| TUI       | textual               | Ink (React for terminal)         |
| Agent框架 | LangChain/LangGraph   | 自研core模块                     |
| 向量嵌入  | sentence-transformers | @xenova/transformers 或调用API   |
| 配置文件  | YAML + Pydantic       | JSON + Zod schema验证            |

---

## 十、参考文件索引

| 课程内容            | 文件路径     | 关键知识点                       |
| ------------------- | ------------ | -------------------------------- |
| Harness原理与概念   | 专题课Part 1 | 8故障模式 + 8机制 + 3支柱        |
| mini-Harness手搓    | 专题课Part 2 | Agent Loop代码参考               |
| Hermes记忆系统      | 专题课Part 4 | SQLite+FTS5 + Nudge机制          |
| Agent Skills        | Part 6       | SKILL.md格式 + skill-creator-pro |
| 长短期记忆管理      | Part 7       | 记忆分层 + 压缩策略              |
| 上下文工程          | Part 8       | Context Budget + 组合编排        |
| Claude Code源码解读 | 加餐公开课   | query.ts架构 + 记忆系统          |

---

## 十一、Claude Code源码架构参考（专题课补充）

### 11.1 核心架构文件清单

Claude Code泄露源码（v2.1.88）提供了51.2万行TypeScript实现参考：

| 核心文件            | 行数  | 职责                           | Zuse对应                   |
| ------------------- | ----- | ------------------------------ | -------------------------- |
| `QueryEngine.ts`    | 1,295 | 推理引擎：会话级编排、单例管理 | @zuse/core Agent           |
| `query.ts`          | 1,729 | 核心循环：AsyncGenerator驱动   | Phase 3.5 Agent Loop       |
| `context/`          | 1,004 | 上下文组装、注入、边界追踪     | Phase 8 Context Management |
| `services/compact/` | —     | AutoCompact压缩服务            | Phase 8 压缩策略           |
| `utils/messages.ts` | 5,512 | 消息处理含MicroCompact         | Phase 2 消息管理           |

### 11.2 记忆系统架构（memdir）

```
src/memdir/
├── memdir.ts              ← 记忆目录核心逻辑
├── memoryTypes.ts         ← 四种记忆类型定义
├── memoryScan.ts          ← 记忆扫描
├── findRelevantMemories.ts ← 相关记忆检索
└── ...

src/services/
├── autoDream/             ← Auto Dream 记忆巩固服务
├── SessionMemory/         ← 会话记忆压缩
├── extractMemories/       ← 记忆提取
```

**四种记忆类型**（memoryTypes.ts）：

- user记忆：用户偏好、工作习惯
- project记忆：项目结构、约定
- feedback记忆：用户纠正、反馈
- reference记忆：外部资源指针

### 11.3 安全架构（23项Bash安全检查）

```
src/tools/BashTool/
├── bashSecurity.ts        ← 2,592行，23项安全检查
├── bashPermissions.ts     ← 权限管理
├── shouldUseSandbox.ts    ← 沙箱判断逻辑
```

**23项安全检查要点**：

1. 禁止rm -rf /
2. 禁止sudo（除非显式允许）
3. 禁止环境变量泄露
4. 命令白名单/黑名单
5. 路径访问限制
6. 网络请求限制
7. 进程信号限制
   ...

**Zuse Phase 5可借鉴**：

```typescript
interface BashSecurityCheck {
  id: number
  name: string
  description: string
  check: (command: string) => boolean | SecurityWarning
}

const securityChecks: BashSecurityCheck[] = [
  { id: 1, name: 'no-rm-rf-root', check: (cmd) => !cmd.match(/rm\s+-rf\s+\//) },
  { id: 2, name: 'no-sudo-default', check: (cmd) => !cmd.includes('sudo') },
  // ... 共23项
]
```

### 11.4 多Agent架构（Coordinator Mode）

```
src/coordinator/
└── coordinatorMode.ts     ← 369行，多Agent编排

src/tools/
├── AgentTool/             ← 子Agent生成
├── SendMessageTool/       ← Agent间通信
├── TaskCreateTool/        ← 任务创建
└── TaskOutputTool/        ← 任务输出获取
```

**Zuse Phase 10+可借鉴**：

```typescript
interface CoordinatorConfig {
  maxSubAgents: number // 最大子Agent数
  taskQueue: Task[] // 任务队列
  messageChannel: Channel // Agent间通信管道
}

interface SubAgent {
  id: string
  task: string
  status: 'running' | 'completed' | 'failed'
  output?: string
}
```

### 11.5 42个工具完整清单

Claude Code内置42个工具，Zuse Phase 3-4可参考优先级：

| 优先级 | 工具            | Claude Code实现            | Zuse Phase |
| ------ | --------------- | -------------------------- | ---------- |
| P0     | FileReadTool    | FileReadTool/              | Phase 3.3  |
| P0     | FileWriteTool   | FileWriteTool/             | Phase 4.1  |
| P0     | FileEditTool    | FileEditTool/              | Phase 4.2  |
| P0     | BashTool        | BashTool/ (2592行安全检查) | Phase 4.3  |
| P0     | GlobTool        | GlobTool/                  | Phase 4.5  |
| P0     | GrepTool        | GrepTool/                  | Phase 4.6  |
| P1     | WebFetchTool    | WebFetchTool/              | Phase 10+  |
| P1     | WebSearchTool   | WebSearchTool/             | Phase 10+  |
| P1     | TodoWriteTool   | TodoWriteTool/             | Phase 2.5+ |
| P2     | AgentTool       | AgentTool/                 | Phase 10+  |
| P2     | SendMessageTool | SendMessageTool/           | Phase 10+  |
| P2     | SkillTool       | SkillTool/                 | Phase 10+  |

### 11.6 压缩服务架构（services/compact）

**AutoCompact触发条件**：

- token接近context window阈值
- 用户显式请求 `/compact`
- 会话切换时自动压缩

**压缩策略**：

```typescript
interface CompactPolicy {
  method: 'summarize' | 'truncate' | 'selective'
  preserveFirstTurn: boolean // 保留首轮
  preserveDecisions: boolean // 保留关键决策
  preserveRecentN: number // 保留最近N轮
}
```

### 11.7 Skills系统实现

```
src/skills/
├── SkillLoader.ts         ← 技能加载
├── SkillRegistry.ts       ← 技能注册
├── SkillMatcher.ts        ← 技能匹配
```

**加载机制**：

1. 启动扫描 `~/.claude/skills/`
2. 解析frontmatter
3. 按需加载完整内容 + references

### 11.8 Slash命令系统

Claude Code有87+个斜杠命令：

| 命令            | 功能          | Zuse参考  |
| --------------- | ------------- | --------- |
| `/compact`      | 压缩对话历史  | Phase 8   |
| `/model`        | 切换模型      | Phase 6   |
| `/clear`        | 清空对话      | Phase 2   |
| `/save` `/load` | 会话保存/加载 | Phase 8   |
| `/memory`       | 查看记忆      | Phase 9   |
| `/tools`        | 列出工具      | Phase 4   |
| `/review`       | 自动评审      | Phase 10+ |
| `/mode`         | 权限模式      | Phase 5   |

---

## 十二、Claude Code vs Zuse架构对比

| 方面     | Claude Code             | Zuse目标            |
| -------- | ----------------------- | ------------------- |
| 语言     | TypeScript (51.2万行)   | TypeScript (~1万行) |
| 运行时   | Bun                     | Node.js + tsx       |
| TUI      | 自研ink引擎 (50x优化)   | Ink 5               |
| 核心循环 | query.ts AsyncGenerator | Phase 3.5 类似设计  |
| 记忆     | memdir + autoDream      | Phase 9 SQLite      |
| 安全     | 23项Bash检查            | Phase 5 基础检查    |
| 多Agent  | Coordinator + AgentTool | Phase 10+           |
| Skills   | SKILL.md格式            | Phase 10+           |

**核心借鉴点**：

1. **query.ts的AsyncGenerator模式** → Zuse Agent Loop设计
2. **context/的预算分配** → Zuse Token Budget
3. **services/compact/压缩策略** → Zuse Phase 8压缩
4. **bashSecurity.ts安全检查** → Zuse Phase 5权限
5. **memdir记忆类型定义** → Zuse Phase 9记忆系统

---

## 十三、源码参考文件索引

| 内容                    | 文件路径                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Claude Code源码说明     | 【加餐】公开课/【加餐】Claude Code 源码解读/Claude Code源码/源码参考/源码参考说明.md            |
| Claude Code专题课Part 2 | 【专题课】Claude Code架构与源码深度解析/Part 2. Claude Code 浓缩版第 1 节·能力与安全边界/       |
| Claude Code专题课Part 3 | 【专题课】Claude Code架构与源码深度解析/Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程/ |
| 源码目录                | 【加餐】公开课/【加餐】Claude Code 源码解读/Claude Code源码/源码参考/collection/                |

---

_本文档随Phase进度逐步纳入设计文档，每个Phase设计时参考对应章节。_
