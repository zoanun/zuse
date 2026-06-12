# Zuse 项目记忆设计(Phase 13)

> 2026-06-12。三件事:**指令文件**(用户/项目级常驻指令进系统提示词)、
> **SQLite+FTS5 记忆库 + Memory 工具**(模型可保存/检索跨会话事实)、
> **MEMORY.md 投影 + 启动注入**(轻量 Nudge:记忆变更即重投影,启动时整体召回)。
> 对照:CC 的 memdir(文件制)与课程 Hermes 的 SQLite+FTS5(库制)——zuse 按
> roadmap 选库制,但保留 MEMORY.md 这个人类可读的投影层(两家的优点各取一半)。

## 0. 三层记忆的分工

| 层 | 载体 | 写入者 | 读取时机 |
| --- | --- | --- | --- |
| 常驻指令 | `~/.zuse/SYSTEM.md`(用户全局)、`ZUSE.md`(项目,向上逐级收集) | 用户手写 | 每会话启动,全文进系统提示词 |
| 结构化记忆 | `~/.zuse/memory.db`(SQLite+FTS5) | 模型经 Memory 工具 | 模型按需 search;启动时经投影整体召回 |
| 召回索引 | `~/.zuse/MEMORY.md`(生成物) | 投影自动重建 | 每会话启动,随指令进系统提示词 |

## A. 指令文件(SYSTEM.md / ZUSE.md)

- **`~/.zuse/SYSTEM.md`**:用户全局指令(语言偏好、工作习惯),对所有项目生效。
- **`ZUSE.md`**:项目指令。从 cwd **向上逐级收集到根**,外层在前内层在后
  (内层更具体、后出现权重更高)——monorepo 里仓库根与包级 ZUSE.md 都生效。
- 注入顺序:身份提示词 → 环境块 → SYSTEM.md → ZUSE.md(外→内)→ MEMORY.md。
  每段带来源标头(`## User instructions (~/.zuse/SYSTEM.md)` 等),模型知道指令
  来自哪一层。
- **尺寸护栏**:单文件截 20k 字符(行边界,带 truncation 标记)——指令文件失控
  不能演变成窗口爆炸(故障模式②)。
- 落点:core `instructions.ts`(`loadInstructionFiles(home, cwd)` 纯 IO 函数,
  测试注入临时目录);`buildSystemPrompt` 增可选 `sections: Array<{title, content}>`。
  TUI 挂载时读一次(useMemo,与 systemPrompt 同生命周期)。
- **不热加载**:会话中途改 ZUSE.md 不生效(系统提示词稳定才有 prompt cache 命中;
  与 CC 行为一致)。

## B. 记忆库(SQLite + FTS5)

- **选型**:Node 22.22 内置 `node:sqlite`(`DatabaseSync`),FTS5 已编译进——
  零原生依赖(better-sqlite3 要 node-gyp,Windows 上是常见坑)。代价:import 时
  打一条 ExperimentalWarning 到 stderr(无运行时开关可关),接受。
- **单库多项目**:`~/.zuse/memory.db`(`ZUSE_MEMORY_DB` 注入),表带 `project`
  列(cwd-slug;空串 = 全局)。user 型记忆天然全局,project/insight 型挂项目。
- **Schema**:
  ```sql
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('user','project','insight','reference')),
    content TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',   -- cwd-slug;'' = 全局
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='id');
  -- insert/update/delete 三个触发器同步 FTS 表(external content 标准接法)
  ```
- **四种类型**(对齐课程 11.2 的「记忆类型」框架,命名取 zuse 自己的):
  `user` 用户是谁/偏好(全局);`project` 项目事实与约束;`insight` 经验教训
  (踩过的坑、被纠正过的做法);`reference` 外部资源指针(URL/文档位置)。
- **检索**:FTS5 `MATCH`;用户查询先做**词项清洗**(按空白拆词、每词双引号包裹
  再 OR 连接)——FTS5 的查询语法字符(AND/OR/NOT/`*`/`"`/`-`)直接拼会抛
  syntax error,模型传中文短语更是必炸。范围 = 当前项目 ∪ 全局。

## C. Memory 工具

- 单工具带 `action` 参数:`save`(type+content)/ `search`(query)/ `list` /
  `delete`(id)。一个工具而非四个:模型的工具清单已不短,记忆操作语义内聚。
- **`readOnly: true`(有意拉伸语义,记录理由)**:权限闸里 readOnly 的实质语义
  是「不触碰用户工作区、无需确认、可并发」。Memory 的写入只落 zuse 自有数据库
  (`~/.zuse/memory.db`),不碰项目文件、不动 cwd、不竞争文件锁 —— 三条全符合。
  若每次 save 都弹确认,模型就不会save,功能等于没做(CC 的记忆写入同样不弹)。
- 失败路径走 observation contract:库打不开降级提示「记忆不可用」;delete 未命中
  id 回显现有 id 列表;search 无结果建议换词。

## D. MEMORY.md 投影 + 启动注入(轻量 Nudge)

- **投影**:save/delete 成功后同步重建 `~/.zuse/MEMORY.md`——按类型分组、每条
  一行(`- [id] content 截 120 字符`),文件头注明「自动生成,改了会被覆盖,
  源在 memory.db」。db 是唯一真相源。
- **启动注入**:MEMORY.md 全文(截 8k 字符)作为最后一个 section 进系统提示词
  ——模型开场即知道历史记忆的索引,细节用 Memory search 拉取。
- **范围裁剪**:投影按「当前项目 ∪ 全局」过滤?**否** —— MEMORY.md 是全局单文件,
  投影全量;注入时不裁(8k 上限兜底)。v1 记忆量小,按项目分文件等量大了再说。
- **有意不做**(记 backlog):LLM 驱动的记忆巩固(CC 的 Auto Dream / 课程的
  自动 review)——v1 投影是确定性纯函数,零成本零延迟;每回合 LLM 审一遍
  「有什么值得记」既贵又吵。

## E. 情景记忆 recall(Phase 13.5,追加)

语义记忆(B/C)存蒸馏后的结论,回答不了「我们十天前讨论 X 时是怎么说的」——
要引用的是**对话原文**。原始数据 Phase 10A 已全量落盘(自动会话 JSON),只缺
检索通道:

- **episodes 索引**:`memory.db` 加 episodes 表(+FTS5 trigram),索引历史会话
  里 user/assistant 的 text 块;tool_use/tool_result **不进索引**(动辄千行的
  命令输出会把真正的讨论淹掉)。单条消息截 4k 字符。
- **懒索引 + 增量**:不在 autosave 时同步建(每回合写放大,recall 是低频操作);
  recall 时按会话 `updatedAt` 水位增量同步 —— 变了的会话整体重建,没变的跳过。
- **时间过滤按会话粒度**:会话文件没有逐条消息时间戳,`days` 参数过滤的是
  「最近 N 天更新过的会话」。
- **工具面**:Memory 工具加 `recall` action(query 必填、days 可选),返回
  `[日期 会话id] role: 片段` + `/resume <id>` 回看指引;FTS 用内建 snippet()
  截片段,LIKE 回退(两字中文词)手工截窗。

## F. 源码对照增强(同日追加;对照 cc-haha / opencode / openclaw / hermes-agent)

通读四家记忆实现后落地五项(各自的对照来源与有意取舍):

1. **recall 上下文窗口**(Hermes session_search):命中带锚点 ±2 条对话(zuse 索引
   只收 user/assistant 文本,±2 ≈ Hermes 含工具消息的 ±5 的有效跨度),邻居截
   150 字符,锚点 ▶ 标记。
2. **记忆年龄标注**(CC memoryAge):search/list 与投影行带「N 天前」(当天不标),
   软提醒不硬过期。
3. **压缩前记忆冲刷**(OpenClaw memory flush):摘要请求顺带抽取 MEMORY 候选行
   (≤3 条)入库 —— 有意不学独立子代理回合,零额外请求。
4. **满容硬闸**(Hermes 容量语义):save 前预演投影,将超 8k 即拒绝并给整理路径
   —— 把维护压力放在写入那一刻,不静默截断。
5. **自动巩固**(CC autoDream / OpenClaw Dreaming 的轻量版):投影 >70% 上限且距
   上次 ≥24h,后台单次**无工具**请求输出 DELETE/SAVE 操作行,harness 确定性应用;
   安全帽 = 单次删除 >20 条整体放弃。**有意不做** CC 的「回合末后台抽取兜底」——
   实测 deepseek-v4-flash 会自主存,冲刷又兜住压缩时机,边际价值配不上每回合
   一次后台请求。

可见性约定:Memory 工具块标题显示 action+要点;冲刷结果并入压缩提示行;巩固
前后各一条 🧠 系统行;启动载入记忆索引提示条数。

**不抄的**:OpenClaw 的嵌入向量混合检索(要 embedding key/成本/网络,当前量级
FTS 召回率瓶颈未出现);Hermes 的双 FTS 表(unicode61+trigram 双索引,zuse 的
trigram+LIKE 已覆盖同一问题面,体积减半)。

## 设计决策汇总

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | node:sqlite,不引 better-sqlite3 | 零原生依赖;Windows node-gyp 是常见坑;FTS5 已内置 |
| D2 | 库制(SQLite)+ 文件投影(MEMORY.md) | roadmap/课程选库制;投影补回文件制的人类可读性 |
| D3 | Memory 工具 readOnly: true | 写入面 = zuse 自有库,符合 readOnly 的实质语义;弹确认会杀死功能 |
| D4 | ZUSE.md 向上全收集(外→内) | monorepo 仓库根与包级指令都生效;内层后出现权重更高 |
| D5 | 指令/投影注入只在启动时一次 | 系统提示词稳定 = prompt cache 命中;会话中途不热加载 |
| D6 | FTS 查询词项清洗(引号包裹 + OR) | FTS5 语法字符与中文短语直接拼必炸 |
| D7 | 单库 project 列,不按项目分库 | 跨项目的 user 记忆天然共享;一个文件好备份 |
| D8 | 不做 LLM 记忆巩固(v1) | 投影零成本;每回合 LLM 审查既贵又吵,等记忆量大了再立项 |
