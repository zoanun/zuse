# Phase 12 检查点与回滚 —— 手写实施计划(TDD)

> 配套设计 spec [→](../specs/2026-06-12-zuse-checkpoint-revert-design.md)。
> **本计划供用户手写实现用**,每步先红后绿;命令级机制、决策理由见 spec,这里只列
> 落点、接口与测试清单。

## 阶段 1:影子 git 快照模块(纯基建,无 UI)

**落点**:`packages/tools/src/snapshot.ts` + `snapshot.test.ts`(放 tools 包:
要 spawn git,与 bash.ts 同属进程基建;core 不引进程依赖)。

**接口契约**:

```ts
export interface SnapshotStore {
  /** 懒初始化影子仓库;git 不可用/初始化失败返回 false(后续调用全部降级 no-op)。 */
  ensure(): Promise<boolean>
  /** add -A + commit,返回 commit hash;失败返回 null(降级,绝不抛)。 */
  track(): Promise<string | null>
  /** 工作区精确回到 hash 时刻(read-tree + checkout-index + clean -fd)。失败抛错(调用方要把失败告知用户,这步不能静默)。 */
  restore(hash: string): Promise<void>
  /** 自 hash 以来的改动摘要(git diff --stat),给 /revert 确认 UI。 */
  diffStat(hash: string): Promise<string>
}
export function createSnapshotStore(cwd: string): SnapshotStore
```

环境注入:`ZUSE_SNAPSHOTS_DIR`(镜像 `ZUSE_SESSIONS_DIR` 模式);目录布局
`<root>/<cwd-slug>/`,slug 函数与 sessionStore 共用(从 sessionStore 导出复用,
别复制)。

**测试清单(临时目录起真 git,集成测试;Windows 上跑得动)**:

1. `ensure` 在空目录创建影子仓库;再次调用幂等。
2. `track`:新建文件 → hash A;改文件再 track → hash B ≠ A;**无改动 track →
   仍产新 hash(--allow-empty)**。
3. `restore(A)` 后:被改文件内容复原、被删文件复活、**A 之后新建的文件被删**。
4. `.gitignore` 里的文件(建 `ignored.txt` + `.gitignore`)不进快照、restore 时不被 clean 删。
5. 用户项目自身是 git 仓库时:影子操作**不碰** `./.git`(断言用户仓 `git status` 不变)。
6. git 不存在(PATH 注入空)→ `ensure` false、`track` null,不抛。
7. `restore` 对未知 hash 抛错(而非静默成功)。

**验收**:`pnpm -F @zuse/tools test` 绿;手工在 zuse 仓库本体上跑一次 track/restore
冒烟(用 ZUSE_SNAPSHOTS_DIR 指到临时目录,别污染 ~/.zuse)。

## 阶段 2:SessionRecord v3 + 每回合打点

**落点**:`packages/tui/src/commands/sessionStore.ts`、`packages/tui/src/hooks/useConversation.ts`。

1. SessionRecord 升 v3,加 `checkpoints: SessionCheckpoint[]`(结构见 spec §3);
   `loadAutoSession` 读 v2 时 checkpoints 缺省 `[]`(向后兼容测试)。
2. useConversation:挂载时 `createSnapshotStore(cwd)` 存 ref;`sendMessage` 顶部
   (auto-compact 之后、runAgent 之前)发起 `track()`,promise 存 ref;回合提交后
   (现 autosaveSession 调用处)await 该 promise,hash 非 null 则 push 检查点
   `{ messageIndex: 本回合用户消息下标, hash, at, label: userText.slice(0, 80) }`,
   随 autosave 落盘。
3. **压缩联动**(最易漏):`compactConversation` 与 auto-compact 路径里,按
   spec §5 规则修正 checkpoints(折叠区间内的删除、保留区间的下标重映射)。

**测试清单**:

1. sessionStore:v3 写读往返;v2 文件读入 checkpoints=[]。
2. checkpoints 下标重映射的纯函数(建议抽 `remapCheckpoints(checkpoints, cutIndex, summaryCount)`
   到 sessionStore 或 compaction 旁)单测:折叠区间内删除 / 之后的平移 / 边界(恰在切点)。
3. （hook 层行为靠阶段 3 的 /revert 测试间接覆盖,不单独为 hook 起 renderer 测试——
   与 autosave 的既有测试深度保持一致。）

## 阶段 3:/revert 命令

**落点**:`packages/tui/src/commands/registry.ts`(+ CommandContext 扩展)。

1. `/revert` 无参:列检查点(倒序,序号 + 时间 + label),底部提示
   「/revert <序号> 回滚;影子仓库保留全部历史,误滚可再 revert 到更近的点」。
2. `/revert <序号>`:先 `diffStat(hash)` 展示改动范围 → 确认(复用权限弹框的
   SelectList 形态或最简 y/N)→ `restore(hash)` → 账本截断到 messageIndex →
   `generation++` remount → FileReadTracker 清空 → autosave。restore 抛错时
   原样报给用户,账本**不**截断(文件没回去,账本更不能动)。
3. 序号越界 / 无检查点 / hash 已失效(影子仓库被手删)各给明确中文提示。

**测试清单**(registry 测试沿用既有 ctx mock 模式):

1. 无参列表输出含序号与 label;空检查点提示。
2. 带序号:调用顺序 = diffStat → 确认 → restore → 截断 → generation++(用 spy 断言顺序与参数)。
3. restore 抛错 → 账本未截断、错误透出。
4. 截断后 messages 长度与 checkpoints 同步修剪(messageIndex ≥ 截断点的检查点一并删除)。

## 阶段 4:出错提示联动(D6 的轻量替代)

回合 error 且本回合已有检查点时,错误信息后追加一行提示:
「本回合的文件改动可用 /revert 撤销」。纯文案,一条测试。

## 收尾

- roadmap Phase 12 标 ✅ + spec/plan 链接;README Status 段更新。
- 全量 test / typecheck / lint;分粒度提交(建议:tools 快照模块 / sessionStore v3
  / 压缩联动 / /revert 命令 / 文档,5 个 commit)。
