# Agent 记忆框架横向对比：mem0 / Zep / Letta vs Zuse

> **日期**: 2026-07-14
> **性质**: 调研 + 评估文档（**非**实现 spec）。对应路线图 `2026-06-22-web-ui-roadmap.md` §8。
> **方法**: Zuse 侧基线**逐行读实际源码**建立（`packages/tools/src/memory-store.ts`、`memory.ts`、`packages/core/src/memory-consolidation.ts`）；三个候选用 context7 拉 **2026-07 当前文档**（训练数据可能过时，这几家迭代快）。
> **未实测项（诚实标注）**: 三家**未跑 live demo**（Zep/Letta/mem0 的完整体验需外部基建：Neo4j / Postgres / 向量库 + embedder + LLM key，与本机 local-first、离线约束冲突，成本高）。因此"召回质量"维度是**基于范式的推断**，非受控 benchmark；许可证/版本号以集成时实测为准。要针对性起某一家的最小 demo，说一声。

---

## 0. 结论先行（TL;DR）

**加权总分（满分 80，权重偏 local-first / 解耦 / 召回质量）：Zuse 69 > mem0 55 > Zep 47 > Letta 41。**

**推荐：继续自研，按需吸收单点能力。** 在"**不破坏 local-first、不引入外部服务**"这两条硬约束下，**没有任何一家显著超过现状**——它们的优势（向量语义召回 / 时间知识图谱 / agent 自管记忆）都以"引入 embedder + 向量库 / 图库 / 独立运行时"为代价，直接踩中 Zuse 的最高权重约束。

命中 §8.5 决策树的第一分支。具体吸收哪些单点能力见 §6。

---

## 1. Zuse 现状基线（源码实证，比路线图 §8.1 概述更全）

读实际源码后确认，Zuse 记忆**不止**路线图写的"SQLite+FTS 语义记忆"一层，而是一套更完整的机制：

### 1.1 存储与检索
- **存储**: `better-sqlite3` + **FTS5**，单文件 `~/.zuse/memory.db`。零外部服务、离线、随进程退出释放。（`memory-store.ts:openMemoryStore`）
- **检索**: FTS5 **trigram** 分词 + **LIKE 子串兜底**（trigram 需 ≥3 字符，两字中文词命中不了 → LIKE 回退；FTS 语法字符经 `sanitizeFtsQuery` 引号包裹）。**关键词/全文检索，非向量、无 embedding。**
- **类型**: `user`（强制全局，跨项目）/ `project`（cwd-slug 隔离）/ `insight`（教训/纠正）/ `reference`（外部指针）。
- **项目隔离**: `project` 列 = cwd-slug（`''`=全局）；search 范围 = 该项目 ∪ 全局；管理面板"全部"视图 = 跨所有项目。
- **索引钩子**: `hook` 列 = 作者（模型）写的一行式要点，`MEMORY.md` 投影优先用它（无则回退正文前缀截断，`PROJECTION_LINE_CAP=120`）。

### 1.2 注入与投影
- 会话启动把 **`MEMORY.md` 投影**（`renderMemoryMarkdown`：按类型分组、每条带 id + 项目范围 + 年龄）注入 system prompt。db 是唯一真相源，md 是生成物。

### 1.3 写入/巩固/时效（路线图 §8.1 未提到的部分）
- **显式 save**：模型经 `Memory` 工具主动存（`readOnly:true` 拉伸——只落自有库、不碰工作区，故免确认）。
- **写入时矛盾轻推**：save 成功后用新内容反查相近旧记忆，`ACTION REQUIRED` 提示模型**当场**删除被取代的旧条目（实测 deepseek 存新不会主动想起删旧，而这一刻它最清楚哪条过时）。
- **满容硬闸**：若投影将超 `MEMORY_INDEX_CAP` → 拒绝保存、要求先整理（不静默截断丢尾部）。
- **自动巩固**（autoDream-lite，`memory-consolidation.ts`）：投影体积 ≥ 上限 70% 且距上次 ≥24h 才触发；模型读全量清单、输出 `DELETE`/`SAVE` 操作行，harness 确定性应用；单次删除超 20 条**整体放弃**（防跑飞）。巩固代理**无任何工具权限**，出错面收敛到"解析不出 = 什么都不做"。
- **年龄标注**：≥1 天的记忆标"N 天前"（对齐 CC memoryAge），提醒模型核对时效。

### 1.4 情景记忆（第二层，路线图 §8.1 完全未提）
- `Memory` 工具的 `recall` 动作 + `episode-store.ts`：对**历史对话转录**做 FTS，返回命中片段 + session id（"我们之前聊 X 聊过啥"），可 `/resume <id>` 重开。**语义记忆（事实）与情景记忆（对话）分表、共用一个 db 文件。**

> **一句话基线**：Zuse = 本地嵌入式 SQLite 上的（关键词检索语义记忆 + 对话情景检索）双层，配显式写入 + 半自动巩固 + 写入时矛盾轻推 + 满容闸 + 年龄标注。**硬约束达成度极高（零依赖、离线、可 CRUD 审计），最弱项是时间感知（仅年龄标注，无失效/版本化）和自动抽取（靠模型显式 save，非自动从对话抽取）。**

---

## 2. 候选画像（context7，2026-07 当前文档）

### 2.1 mem0（`/mem0ai/mem0`）
- **范式**：**向量语义记忆**——LLM 自动从对话**抽取"事实"**并增量 add/update/dedup（这是它的招牌），向量库存储 + 语义 search/get_all。
- **依赖**：需 ①向量库（Qdrant/Chroma/Redis/Supabase，Chroma 可本地文件、亦有 `~/.mem0/vector_store.db` 的 SQLite 向量路径）②LLM ③embedder。默认 provider 走 `OPENAI_API_KEY`（`text-embedding-3-small` + fact-extraction 模型）。
- **能否全本地/离线**：**能**——Ollama 跑 LLM + embedder，Chroma/SQLite 存向量。但**必然多出一个 embedder 依赖 +（通常）一个向量库进程**。
- **形态**：Python 库（也有托管平台 + MCP server）。可作为"库"嵌入。

### 2.2 Zep / Graphiti（`/websites/help_getzep`）
- **范式**：**双时态知识图谱**——实体/关系带时间有效区间（`valid_at`/`invalid_at`），Graph RAG。时间感知是全场最强。
- **关键结构事实**：**Zep 本体 = 企业/云**（Context Lake、SOC2/HIPAA/BYOC、<200ms）。**OSS 部分 = Graphiti 库**。Graphiti 需 **Neo4j（或 FalkorDB）图库**（`bolt://localhost:7687`）+ LLM + embeddings + **cross-encoder/reranker**。官方定位："Graphiti 适合本地跑单主体的单个 Context Graph；Zep 面向大规模。"
- **能否全本地/离线**：Graphiti 理论可本地（Neo4j Community + Ollama），但**依赖最重**（图库进程 + LLM + embedder + reranker）；完整 Zep 体验是云。
- **形态**：Graphiti 是库但强绑图库服务；Zep 是外部服务。

### 2.3 Letta / MemGPT（`/websites/letta`）
- **范式**：**分层记忆 + agent 自编辑**——core memory blocks（in-context）/ recall memory / archival memory（向量库经工具查）/ files；agent 用工具自己管理 context 窗口。是"记忆即 agent 能力"。
- **依赖**：`letta --backend local` 内嵌后端（无需登录，agent 状态存本机）**或** Docker + **Postgres**（`~/.letta/.persist/pgdata`）。**本地模式只管状态存储，不使推理本地化**——要全本地推理得接 Ollama/LM Studio/llama.cpp。
- **能否全本地/离线**：能（内嵌后端 + 本地推理 provider），但它是**完整的有状态 agent 运行时/平台**，不是"一个记忆 store"。
- **形态**：**agent 运行时**——它想"拥有"agent（记忆、对话、工具、provider 连接都归它管）。

---

## 3. 10 维加权打分表

评分 1–5（5 最好）。权重按 §8.3 向 local-first / 解耦 / 召回质量倾斜。

| # | 维度 | 权重 | Zuse | mem0 | Zep/Graphiti | Letta |
|---|------|:---:|:---:|:---:|:---:|:---:|
| 1 | 存储/检索范式 + 召回质量¹ | 2 | 3 | 4 | 5 | 4 |
| 2 | 记忆类型/结构表达力 | 1 | 4 | 3 | 5 | 3 |
| 3 | 自动抽取/巩固/去重 | 1 | 3 | 5 | 5 | 4 |
| 4 | 时间感知（失效/衰减/版本化） | 1 | 2 | 3 | 5 | 3 |
| 5 | 多会话/多项目隔离 | 1 | 4 | 4 | 4 | 3 |
| 6 | **local-first / 离线 / 无外部依赖** | **3** | **5** | **3** | **1** | **2** |
| 7 | 运维/依赖成本 | 2 | 5 | 3 | 1 | 2 |
| 8 | **与 core 解耦（可替换 store）** | **3** | **5** | **3** | **2** | **1** |
| 9 | 可扩展/可审计（像 M1 直接 CRUD） | 1 | 5 | 4 | 3 | 3 |
| 10 | License & 活跃度² | 1 | 5 | 4 | 4 | 4 |
| | **加权总分 / 80** | | **69** | **55** | **47** | **41** |

¹ 召回质量为**范式推断**，非 benchmark（未跑 demo）。向量/图范式在模糊/关系型召回上强于 Zuse 的关键词 FTS；但 Zuse 的 FTS+LIKE 对精确/关键词召回够用，且中文经 trigram+LIKE 兜底。
² 三家均为活跃 OSS（mem0 / Graphiti / Letta 常见 Apache-2.0），**集成时以实测 LICENSE 与版本为准**。

---

## 4. 各家"接入 Zuse 的最小改造面"估算

| 框架 | 最小改造面 | 是否破坏离线 | 是否需额外进程 | 是否需抽 store 接口 |
|---|---|:---:|:---:|:---:|
| **mem0** | 作为**可选 store** 塞进已有 `MemoryStore` 接口（Zuse 已有此接口！）；需接 embedder + 向量库配置 | 是（除非配本地 Ollama+Chroma） | 通常是（向量库） | 否（接口已在） |
| **Zep** | 云：改造小但**放弃离线**；Graphiti 自托管：起 Neo4j + reranker，改造大 | **是** | **是（Neo4j）** | 否（外部服务） |
| **Letta** | 大——它要接管 agent 循环，与 `packages/core` 的 runAgent 冲突；只借它的记忆分层则要重写 | 部分 | 是（后端/Postgres） | 不适用（非 store） |

> Zuse **已经**把记忆抽象成 `MemoryStore` 接口（`memory-store.ts` 顶部的 `interface MemoryStore`），这是巨大的既有优势：任何"可替换 store"候选（mem0）理论上能干净接入，SQLite 实现与候选并列成两个 provider——**但引入 embedder 依赖这一条无法回避**。

---

## 5. 决策（对照 §8.5 标准）

§8.5 第一条：**"若没有框架能在不破坏 local-first / 不引入外部服务的前提下显著超过现状 → 继续自研，按需吸收单点能力。"**

- Zep（Neo4j）、Letta（运行时+Postgres）**直接违反**离线/无外部服务，且 Letta 与 core 引擎架构冲突 → **排除为 store 候选**。
- mem0 是唯一"可作可替换 store 干净接入"的候选，但**必带 embedder + 向量库**，仍破坏"无外部依赖"这条最高权重约束 → **不设为默认，至多做可选增强层**。
- **结论：继续自研（SQLite+FTS 保持默认），选择性吸收单点能力。** 不为"功能更多"牺牲解耦与离线两条硬约束。

---

## 6. 建议吸收的单点能力（按性价比排序）

1. **时间感知 / 软失效**（借 Zep 思想，补 Zuse 最弱的 dim 4，成本低）
   - 加 `supersededBy?: number` / `invalidAt?: string` 列；被"写入时矛盾轻推"或巩固判定为过时的记忆**软失效**（不物理删、投影里降权/折叠），而非现在的硬 delete。
   - 复用现有的写入时矛盾轻推 + 巩固管线，改造面小、纯本地、不引依赖。

2. **可选向量召回层**（借 mem0，作为**加法**而非替换）
   - 在已有 `MemoryStore` 接口后并列一个 provider：**仅当用户配置了本地 embedder（Ollama）时启用**向量 search，否则默认 FTS。保持"零配置即离线可用"。
   - 语义召回对"意思相近但用词不同"的记忆有实测价值（尤其英文），但绝不设为强制。

3. **自动抽取（谨慎）**（借 mem0，但保留 Zuse 的显式 + 巩固哲学）
   - 可选：回合结束后一个**无工具、本地**的抽取步，从对话提议候选记忆，但**必须经审阅/轻推**再落库，不做 mem0 式全自动静默写入——Zuse 的可审计性（M1 CRUD）是特色，不能丢。

> 明确**不做**：不引 Neo4j/图库；不接 Letta 运行时；不把向量库设为默认；不牺牲 `MEMORY.md` 可读投影与 M1 直接 CRUD 审计。

---

## 7. 未验证 / 后续可选

- **未跑 live demo**：如需，最小成本顺序建议 = mem0（Ollama+Chroma 全本地，最贴合）> Letta（`--backend local`）> Graphiti（要 Neo4j，最重）。喂同一组 Zuse 真实用例（跨会话事实召回 / 项目隔离 / 标题补全 / 长期偏好），按本表 10 维复评召回质量。
- **许可证/版本**：集成前实测各仓库 LICENSE 与当前主版本。
- **召回质量**：本文的 dim 1 分数是范式推断，真实负载下的召回率需 demo 实测才能定论。

---

# 附录 A：四框架机制深挖 + 记忆组织模式 + Zuse 映射与引入代价

> 2026-07-14 补。每框架由独立研究 agent 用 context7 + web 源佐证产出，机制细节可回溯；Zuse 映射与代价分析基于逐行读源码的基线。**通用警告：各家 benchmark 互相注水、且 LoCoMo/LongMemEval 只测"从对话检索"、不测"agent 是否越用越会干活"——不要按分数选型。**（Zep 84%→75.14%→Mem0 复现 58.44% 的公案即例。）

## A.1 记忆组织模式（跨框架抽象出的"好想法"）

| 模式 | 谁在用 | 一句话 | Zuse 有没有 |
|---|---|---|---|
| **自动事实抽取** | Mem0 / Cognee / Zep / Letta(agent) | 从对话自动蒸馏出"事实"入库 | ⚠️ 半有：靠模型经工具**显式** save，非被动全自动 |
| **双时态失效** | Zep(招牌) / Mem0 v3(ADD-only+expiration) / Cognee(TEMPORAL) | 事实变了不删旧的，关旧的有效期+开新边，可点时间查询 | ❌ 只有"N 天前"标注 + 硬删除 |
| **图/关系组织** | Zep / Cognee / Mem0(实体层) | 实体+关系边，支持多跳"X 依赖啥" | ❌ 扁平分型行，无关系 |
| **向量语义检索** | 全部 | embedding 相似度召回"意思相近" | ❌ FTS 关键词 + LIKE |
| **混合检索(向量+BM25+图, RRF/rerank 融合)** | Zep / Cognee / Mem0 | 多路召回融合排序 | ⚠️ 仅 FTS + LIKE 兜底 |
| **分层记忆 + 上下文分页 + 自编辑** | Letta/MemGPT | in-context core block ↔ 外部 archival，agent 自己换页、自动压缩 | ⚠️ 部分：全量注入 MEMORY.md + 70% 触发巩固，非按需分页 |
| **自改进/反馈重加权** | Cognee(memify/FEEDBACK) / SimpleMem | 用反馈重加权图/检索，越用越准 | ❌ 无 |
| **巩固/去重/dreaming** | Zuse / Mem0(dedup) / Cognee(memify) | 定期合并去重压缩 | ✅ autoDream-lite（≥70% 且 ≥24h，DELETE/SAVE 操作行，删>20 整体放弃） |
| **情景记忆(搜历史对话)** | Zuse / Letta(conversation_search) / Zep(episodic node) | 检索过去的对话本身 | ✅ recall / episode-store 对转录 FTS |
| **可审计 CRUD** | Zuse | 人能直接列/查/改/删每条记忆 | ✅ M1 面板 + MEMORY.md 可读投影 |

**Zuse 的形状**：强在**巩固 / 情景召回 / 可审计 / 分型作用域 / 零依赖离线**；弱在**语义(向量)检索 / 时间有效性 / 图关系 / 按需分页(扩展性) / 自改进**。

## A.2 各框架机制 + 优缺点（源佐证见 §Sources）

### Mem0（向量事实层，~48K star，最流行）
- **组织**：一条"记忆"= 一句蒸馏事实 + embedding + metadata（id/created/updated/categories/expiration），按 `user_id/agent_id/run_id` 作用域；扁平事实 + 并联实体图。
- **机制**：`add()` = 抽取(单次 LLM 蒸馏事实)→去重→存。**v3 改为 hash 去重 + ADD-only**（只加不改删，靠相关性+时间提升+expiration 顶出当前值）；v2/OSS 曾用 LLM 判 ADD/UPDATE/DELETE/NOOP。检索 `search()` = 向量+BM25+实体+时间提升融合成一个 score（`rerank` 默认关）。历史存本地 SQLite。
- **优**：省 token；后端灵活可自托管(Apache-2.0)；v3 实体图不再需外部图库；生态大。
- **缺**：每次写 = 一次 LLM 调用(延迟+成本)；抽取质量受模型限；**图能力/分析历史长期锁 Pro $249/mo**；2026-04 披露过高危 SQL/Cypher 注入 CVE(CVSS 8.1，须查补丁)；ADD-only 会膨胀条数；benchmark 争议。
- **本地**：**能全离线**(Ollama LLM+embedder + Chroma/Qdrant/in-mem + 本地 SQLite)。Python 为主，**有 Node client**。

### Zep / Graphiti（双时态知识图谱，时间推理最强）
- **组织**：三层节点(Episodic 原始单元 / Entity 实体 / Community 簇)；边分 episodic(`MENTIONS`) 与 entity(`RELATES_TO`，边上挂 fact 字符串+时间戳)；`group_id`/按用户建图 + thread 层。
- **机制**：每条 episode 触发一串 LLM 调用(实体抽取→节点去重→关系抽取→逐边时间归结)。**双时态**：event 轴 `valid_at`/`invalid_at` + ingestion 轴 `created_at`/expiry；事实变了**关旧边有效期+开新边**，不删不改，可点时间/回溯查询。存储 Neo4j(默认)/FalkorDB/Neptune（**嵌入式 Kuzu 已废弃**）。检索 = 向量+BM25+图遍历，RRF 融合(+可选 cross-encoder)，**查询期无 LLM** → 亚秒。
- **优**：原生时间推理("T 时刻什么为真")；多跳关系查询；非破坏式更新有审计；检索快；后端/LLM 灵活。
- **缺**：**摄入贵**——每条消息多次 LLM 调用(Mem0 论文测 Graphiti ~60 万 token/会话 vs Mem0 ~1764，Zep 有异议)；benchmark 公案；**Zep 本体云、OSS 只有 Graphiti 裸核**；依赖重(图库+搜索索引+LLM)；单用户是过度设计。
- **本地**：Graphiti(**Python-only**)可全离线接 OpenAI 兼容端点(Ollama/vLLM)，但**图库服务绕不开**(FalkorDB Lite / Neo4j)，无 server-less 正路。

### Letta / MemGPT（分层记忆 + agent 自编辑，是运行时）
- **组织**：in-context **core memory blocks**(带 label/value/description/字符 limit 默认 5000) + 外部 **recall**(全历史,`conversation_search`) + **archival**(读写向量库,打 tag,无限) + **files**(大文档)。
- **机制**：MemGPT 把 context 当 RAM、外部当磁盘，agent 自己换页；满了 **compact**(滑窗+可用小模型摘要)。**自编辑靠工具**(`memory_insert/replace/rethink`、`archival_memory_insert/search`、`conversation_search`)，模型自己决定何时写。状态存 **Postgres + pgvector**。
- **优**：agent 自管、持久 persona/user；为长时会话而生(自动压缩+分页);共享 block 支持多 agent;可视可审(ADE)。
- **缺**：**是完整有状态 agent 运行时,不是可插拔 store**——接它=让它接管 agent 循环/工具/状态,迁移**2–6 周**、锁定高;**与已有 agent 循环冲突**;需 Postgres+pgvector、上手陡;写记忆吃推理 token;"模型没存就没了"。server 是 Python(**有 TS client**)。
- **本地**：`--backend local` 内嵌状态(但**不使推理本地**,要接 Ollama)；或 Docker+Postgres。

### Cognee（图+向量混合，全嵌入式栈——最贴合 local-first）
- **组织**：知识图谱(实体/关系节点边) + 同源向量 embedding 的**混合**;ECL(Extract→Cognify→Load)管线;可选 OWL 本体;**~14+ 检索模式**(GRAPH_COMPLETION 默认 / RAG / CHUNKS / INSIGHTS / CYPHER / TEMPORAL / FEEDBACK…)。
- **机制**：`cognee.add()` 入原始数据 → `cognee.cognify()` 跑(分类→分块→LLM 抽 KnowledgeGraph→摘要→存 DataPoints) → `cognee.search(query, query_type)`。**存储默认全嵌入式：SQLite + LanceDB(向量) + Kuzu(图)，文件级、进程内、无 server**(可换 Neo4j/Postgres/Qdrant)。`memify()` 后处理重加权/剪枝(内部部分未证)。
- **优**：**全嵌入式本地栈,零基建**;图+向量混合多跳强;每层可换、无锁定;检索面广。
- **缺**：cognify 每次摄入需 LLM+embedder(贵、偏批量);**核心是 Python**(`@cognee/cognee-ts` 疑为薄客户端,非全端口);成熟度/社区小于 mem0(~12K star)、文档滞后;依赖多(LanceDB+Kuzu+SQLite+rdflib+FastAPI);benchmark 自证。
- **本地**：**能全离线**(Ollama LLM+embedder + 默认嵌入式三件套)。Python 3.10–3.14。**Node/TS 无法在进程内嵌入 cognify 核**——只能起它的 FastAPI server 走 HTTP / 用 MCP。

## A.3 若 Zuse 引入，各要付什么代价（本文核心）

> 三条贯穿性的硬代价，先摆前面：
> 1. **语言错配**：Zuse 是 Node/TS + 进程内 `better-sqlite3`。这四家的**引擎核都是 Python**(仅 mem0 有可用 Node client)。除 mem0 外,要用就得**起一个 Python 边车/服务**——Zuse 干净的单进程 Node daemon 就没了。这是"接入 X"话术最爱掩盖的成本。
> 2. **几乎都要 embedder + 每次写一次 LLM**：除"双时态失效"这一个纯本地想法外,其余能力都引入 embedding 依赖或 write 时 LLM 调用。Zuse 现在的**零 embedding FTS** 是真实架构资产。
> 3. **benchmark 不能作为选型依据**(见顶部警告)。

| 想吸收的能力 | 借自 | 在 Zuse 的做法 | 代价 | 值不值(单用户/本地/Node) |
|---|---|---|---|---|
| **双时态软失效** | Zep | 加 `supersededBy?`/`invalidAt?` 列;过时记忆软失效(投影折叠/降权)而非硬删;复用现有"写入时矛盾轻推 + 巩固"管线 | **低**:一个 migration + 投影改动 + 巩固判定微调;**纯本地、零新依赖、纯 TS** | ✅ **最划算**,补最弱维 |
| **可选向量召回** | mem0/Cognee | 在**已有 `MemoryStore` 接口**后并列向量 provider,仅当配了本地 embedder 才启用,默认仍 FTS | **中高**:引入 embedder(Ollama 进程/模型) + 向量索引(better-sqlite3 的 sqlite-vec 可留在进程内,避免起 Qdrant) + save 时算 embedding | ⚠️ 仅当"语义漏召回"成真实痛点;**必须可选、非默认** |
| **图/关系(多跳)** | Zep/Cognee | 要么起图库(破 local-first),要么在 sqlite 里自建实体表 + write 时 LLM 抽关系 | **高**:图库依赖 or 大 schema 改 + 每次写多次 LLM | ❌ 单用户编码助手多跳查询罕见,不值 |
| **按需检索式注入(替代全量注入)** | Letta | 从"每回合全量注入 MEMORY.md"改为"按当前上下文检索只喂相关" | **中高**:改记忆进 prompt 的方式;丢"模型每回合看得见全部"的确定性/简单性 | ⏳ **真正的长期天花板**,但记忆量小时不咬人,现在不做 |
| **被动自动抽取** | mem0 | 回合末一次抽取步从对话提候选记忆 | **中**:每回合/会话一次 LLM + 去重;且冲突 Zuse 的"显式+可审计"哲学 | ❌ 建议不做,显式模型对单用户更可信 |
| **自改进/反馈重加权** | Cognee | 用 M1 的编辑/删除信号重加权检索 | **中**:需先有向量层才有意义 | ⏳ 依赖向量层,靠后 |

**直接把某框架当 store 用的代价小结**：
- **mem0**：唯一有 Node client、能"可替换 store"接进已有 `MemoryStore` 接口的——但仍拖 embedder + 向量库,破"无外部依赖"。至多做可选增强,不设默认。
- **Zep/Graphiti**：Python-only + 图库服务绕不开 → 破 local-first + 起 Python 边车。**排除。**
- **Letta**：是 agent 运行时、想接管 core 引擎循环,与 `packages/core` 架构冲突。**排除。**
- **Cognee**：最贴合 local-first(全嵌入式),但**核是 Python、Node 只能走 HTTP/MCP 边车** → 破"单进程 Node"。是"若哪天要引外部框架"的首选,但没在硬约束下**显著超过**现状零依赖 FTS。

**结论(不变,但更有据)**：继续自研。唯一低代价、纯本地、纯 TS、补最弱维的改进 = **双时态软失效**;其余能力要么引依赖、要么起 Python 边车、要么改架构,对单用户本地 Node 工具都不划算。真要动手先做软失效;要不要上可选向量层,等"语义漏召回"成真实痛点再说(那时先起 mem0/Cognee + Ollama 的最小 demo 实测召回率再定)。
