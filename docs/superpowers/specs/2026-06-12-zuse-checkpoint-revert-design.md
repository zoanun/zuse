# Zuse 检查点与回滚设计(Phase 12)

> 2026-06-12。**本 Phase 实现由用户手写**(roadmap 标注的「完全手写、不让 CC 端到端
> 代劳」练习),本文只做设计:方案选型、机制细节、接口契约、设计决策与边界。配套
> TDD 实施步骤见 plan [→](../plans/2026-06-12-zuse-checkpoint-revert.md)。

## 0. 要解决的问题与分工

现有的「staged 暂存」(agent.ts 的 staged 消息数组)解决的是**账本**事务性:回合
出错时消息不提交,账本永不悬空。但**文件**没有这层保护——工具已经写下去的
Write/Edit/Bash 副作用,回合出错也不会撤销;更没有「回合 N 之前的状态」可言。

| 机制 | 保护对象 | 解决 |
| --- | --- | --- |
| staged 暂存(已有,Phase 3) | 消息账本 | 本回合出错不提交 |
| 检查点与回滚(本 Phase) | 工作区文件(+账本截断) | 已落地的过去回合也能撤 |

## 1. 方案选型(D1):影子 git,不自存 diff

两条路的权衡(roadmap 已列),落定**影子 git**:

- **影子 git**:独立 `--git-dir` 指向 zuse 数据目录、`--work-tree` 指向项目根。
  diff/restore/内容寻址去重全部免费;新建/删除/二进制文件天然覆盖。代价是每回合
  一次 `git add -A` 的开销(大仓可感,见 §6)。
- **自存 diff**:要自己保证「effect 全集」进了缓冲——Bash 的任意副作用(它可以
  写任何文件)根本枚举不了,漏一个 revert 就是半残。**否决**。

影子 git 与用户自己的 `.git` **完全隔离**:所有命令显式带 `--git-dir`/`--work-tree`,
绝不碰用户仓库的 index/HEAD/refs;项目不是 git 仓库也照样工作。

## 2. 影子仓库机制(命令级)

落盘位置:`~/.zuse/snapshots/<cwd-slug>/`(沿用 sessions 的 cwd-slug 分组约定),
测试经 `ZUSE_SNAPSHOTS_DIR` 注入(沿用 `ZUSE_SESSIONS_DIR` 模式)。

```
初始化(懒,首次 track 时):
  git --git-dir=<dir> --work-tree=<cwd> init
  git --git-dir=<dir> config core.autocrlf false     # Windows 关键:防换行符churn出假diff
  git --git-dir=<dir> config user.name zuse-snapshot # commit 需要身份,新机器可能没全局配置
  git --git-dir=<dir> config user.email snapshot@zuse.local
  git --git-dir=<dir> config commit.gpgsign false    # 用户全局开了签名会卡在 gpg 上

track()(每个用户回合开始前):
  git --git-dir=<dir> --work-tree=<cwd> add -A
  git --git-dir=<dir> --work-tree=<cwd> commit -m <ISO时间戳> --allow-empty --no-verify
  git --git-dir=<dir> rev-parse HEAD        → 返回 commit hash

restore(hash)(回滚到某检查点):
  git --git-dir=<dir> --work-tree=<cwd> read-tree <hash>^{tree}
  git --git-dir=<dir> --work-tree=<cwd> checkout-index -a -f   # 写回快照内容
  git --git-dir=<dir> --work-tree=<cwd> clean -fd              # 删掉快照之后新建的文件

diffStat(hash)(给 /revert 确认 UI 用):
  git --git-dir=<dir> --work-tree=<cwd> add -A                 # 先刷新 index 才能对比工作区
  git --git-dir=<dir> --work-tree=<cwd> diff --stat <hash> HEAD
```

机制要点:

- **restore 三连**的语义:`read-tree` 把影子 index 重置为快照树;`checkout-index -a -f`
  把 index 全量写回工作区(覆盖改动、复活被删文件);此时「快照之后新建的文件」在
  index 里没有 → 成为 untracked,`clean -fd` 删除它们(**被 .gitignore 忽略的不动**,
  node_modules/.env 安全)。三步合起来 = 工作区精确回到快照时刻(忽略名单除外)。
- **`add -A` 尊重项目 `.gitignore`**(影子 git 读 work-tree 下的 ignore 文件),
  node_modules / dist / .git 不进快照。推论:**被 ignore 的文件不受保护**(工具改了
  `.env` 回滚不了)——记录为已知边界,v1 不解。
- `--allow-empty`:回合没改任何文件也照常打点,保证「每回合一个检查点」的不变量,
  回滚目标的语义简单(不用处理「这回合没快照」)。
- `--no-verify` + `gpgsign false`:影子仓库绝不能被用户的 hooks/签名配置拖挂。

## 3. 检查点时机与存储(D2/D3)

**时机:每个用户回合开始前打一次**(`useConversation.sendMessage` 顶部、auto-compact
判定之后、runAgent 之前)。pre-turn 快照的含义即「回合 N 的回滚目标 = N 开始前的
世界」。对照 OpenCode 是流前流后各一次;zuse v1 只做流前——流后快照唯一的增量
价值是「区分用户手改与 agent 改动」,不值一倍开销。

**fire-and-forget 不阻塞**:对齐 autosave 的契约——快照失败(git 不存在 / 超时 /
权限)绝不能打断回合,降级为「本回合无检查点」,UI 不打扰(debugLog 记录)。
track 是异步的,但 hash 要在回合提交时可用:发起 track 的 promise 存 ref,回合
结束写 checkpoint 记录时 await 它(通常早已 settle)。

**存储(D3)**:检查点属于会话,挂在 SessionRecord 上(版本升 v3,v2 读入时
`checkpoints` 缺省为 `[]`,向后兼容):

```ts
interface SessionCheckpoint {
  /** 该检查点对应的用户回合首条消息在 messages 里的下标(回滚=截到此下标)。 */
  messageIndex: number
  /** 影子 git commit hash。 */
  hash: string
  /** 打点时间(ISO)。 */
  at: string
  /** 该回合用户输入的前 80 字符 —— /revert 列表的展示标签。 */
  label: string
}

interface SessionRecord {
  version: 3
  // ...v2 字段不变
  checkpoints: SessionCheckpoint[]
}
```

## 4. /revert 语义(D4):文件 + 账本一起回

只回文件不回账本是个坑:账本里模型还"记得"那些改动(tool_result 全在),下一轮
它会基于已不存在的代码状态行动。所以 **/revert <序号> = 两件事原子地做**:

1. `restore(checkpoint.hash)` —— 工作区回到该回合开始前;
2. 账本截断到 `messageIndex`(该回合的用户消息及其后全部删除),`generation++`
   强制 `<Static>` remount(复用 /clear·/load 的既有机制),autosave 落盘,
   FileReadTracker 清空(旧的 mtime 记录已对不上回滚后的文件,会误伤 read-before-edit)。

交互:`/revert` 无参列出检查点(序号 + 时间 + label + `diffStat` 摘要),
`/revert <序号>` 执行;执行前展示 diffStat 并要求确认(回滚是破坏性操作,删掉
的是「回滚点之后的全部文件改动」,包括用户自己手改的部分——必须让用户看到范围)。

**v1 不做 unrevert**(OpenCode 留着回滚前数据可反悔):影子 git 里历史 commit 都在,
真要反悔可以手工 restore 回滚前最后一个检查点——把这条写进 /revert 的输出提示即可,
不为它做 UI。

## 5. 与压缩/续接的交互(边界)

- **压缩(Phase 10B)**:applyCompaction 把老回合折叠成摘要,messages 下标整体
  漂移 → **压缩时必须同步处理 checkpoints**:被折叠区间内的检查点失效删除,
  保留区间的 messageIndex 重新映射(= 原 index − 被删条数 + 摘要占位数)。这是
  实现里最容易漏的一处,plan 里有专门测试。
- **--continue/--resume**:checkpoints 随 SessionRecord 一起载入,跨进程仍可
  回滚——影子 git 在盘上,hash 仍有效。但**载入后世界可能已变**(用户在会话外
  改过文件):diffStat 确认步骤天然兜住,用户看到的就是真实回滚范围。
- **/clear**:换新会话,checkpoints 从空开始;影子仓库不清(历史 commit 无害,
  内容寻址下空间成本极低)。

## 6. 性能与运维边界

- `git add -A` 在大仓(万级文件)上百毫秒级、巨仓秒级。v1 接受(fire-and-forget
  不挡交互);若实测痛,后续可加 `core.untrackedCache true` / `core.fsmonitor`。
- 影子仓库只增不减:v1 不做 GC,记 backlog(`git gc` / 按会话清理皆可后补)。
- **并发**:两个 zuse 进程同 cwd 会抢影子 index 锁(git 自带 index.lock 互斥,
  后到者 track 失败 → 降级无检查点,不会损坏)。v1 接受。

## 7. 设计决策汇总

| # | 决策 | 理由一句话 |
| --- | --- | --- |
| D1 | 影子 git,否决自存 diff | Bash 副作用无法枚举,diff 缓冲注定漏 |
| D2 | 仅 pre-turn 快照,每回合一个 | 回滚目标语义最简;流后快照不值一倍开销 |
| D3 | checkpoints 挂 SessionRecord(v3) | 检查点的生命周期与会话一致,跨进程续接免费 |
| D4 | /revert = 文件 + 账本一起回,先确认 | 只回文件会让模型基于幻影状态行动;破坏性操作必须展示范围 |
| D5 | 快照失败优雅降级,绝不挡回合 | 对齐 autosave 契约,鲁棒性机制自己不能成为新故障点 |
| D6 | **不做**「回合出错自动回滚文件」 | roadmap 原文设想过;否决——出错≠用户想丢掉半成品,Bash 跑一半的合法副作用(装依赖/生成文件)自动撤销比不撤更吓人。出错时提示「可用 /revert 撤销本回合改动」把决定权还给用户 |
| D7 | v1 无 unrevert / 无 GC / 忽略文件不保护 | 边界明确记录,都有手工逃生通道 |
