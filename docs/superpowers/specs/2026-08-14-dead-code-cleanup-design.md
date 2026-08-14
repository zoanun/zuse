# 死代码清理:hooks 子系统 + 删会话不杀 run(回溯审计 C1 / C2)

## 一、C1:hooks 子系统整个接不上,用户配置**静默丢弃**

### 实测证据

```
$ grep -n "hooks" packages/core/src/settings.ts
（无输出）
```

`RawSettings`(`settings.ts:110-134`)**没有 `hooks` 字段**;`mergeLayers`
(`settings.ts:178-233`)是**逐字段显式拷贝**,一条 `hooks` 都没有。
而 `ResolvedSettings.hooks?: HooksConfig`(`types.ts:231`)确实存在,
`agent.ts:526/530` 也确实在读 `deps.settings.hooks?.preToolUse`。

**结论**:`loadSettings()` 产出的 settings 里 `hooks` 恒为 `undefined`。
用户在配置文件里写 `"hooks": {...}`,**不会生效、也不会报错**。

### 处置:**删**,不是「补一行就能用」

`hooks.ts` 只有 46 行,补一行 `if (layer.hooks) out.hooks = ...` 看起来就能通。
**但那个方向已经被判死了**,两条硬伤:

1. **`execSync`**(`hooks.ts:22`)+ `HOOK_TIMEOUT_MS = 10000`:
   一条 hook 最多**同步阻塞整个 daemon 10 秒**。冻的不是一个会话,是**所有**会话
   —— daemon 是单进程、所有会话共用一个事件循环。
2. **项目层 `.zuse/settings.json` 会进 git。** 接上之后,`git clone` 一个不可信仓库
   再在里面开一个会话,就可能执行任意命令 —— 而且是在**工具调用前后自动**执行,
   用户完全无感。这和刚修完的 D2(访问一个网页 → RCE)是同一类。

所以不是「差一行」,是**方向要重做**(异步、有沙箱边界、项目层要显式授权)。
留着一个接不上的半成品,只会让下一个人「顺手接上」而把洞打开。

**删掉的东西要在这份 spec 里留档**,将来真要做时从这里读起。

### 删除清单

| 文件 | 动作 |
|---|---|
| `core/src/hooks.ts` | 删 |
| `core/src/hooks.test.ts` | 删 |
| `core/src/index.ts` 的 `export * from './hooks.js'` | 删 |
| `core/src/types.ts` 的 `HooksConfig` / `HookRule` / `ResolvedSettings.hooks` | 删 |
| `core/src/agent.ts:526/530` 两处 `runHooks(...)` 调用 | 删 |

**注意 `agent.ts` 那两处的返回值**:`preWarnings` / `postWarnings` 被拼进了什么地方?
删之前必须查清楚下游 —— 如果 warnings 有别的来源,那条通路要留着。

## 二、C2:删会话不杀 run,留永生孤儿

`registry.killSession(sessionId)`(`registry.ts:123`)**全仓只有测试在调**
(`registry.test.ts:214/218`,以及 `runsRoutes.ts:90` 的一句注释提到它)。

于是:删掉一个会话,它起过的 run **一条都不会被收掉**。
步骤 4 之后更严重 —— 项目档 `wallClockMs: null` + `onDetach: 'keep'`,
一个孤儿 dev server 会**永远占着端口**,而 UI 里再也看不到它(会话没了)。

### 接到 `delete()`,**不是** `release()`

`SessionService.delete()`(`SessionService.ts:180`)本身就是
「`release()`(离开内存)+ 删盘」。**必须接在 `delete()` 上**:
`release()` 还有 cron 的两个**纯归还**调用方 —— 定时任务跑完把会话放回磁盘,
那时会话还在、用户还会再打开它,把它的 run 杀掉是错的。

**接线形态**:`SessionService` 在 `@zuse/server`,`RunRegistry` 在 `@zuse/tools`,
两者由 `startServer` 组装。所以给 `SessionServiceOptions` 加一个可选回调
`onDelete?: (sessionId: string) => void`,`startServer` 传
`(id) => runs.killSession(id)`。**不直接注入 registry** —— 那会让 server 的会话层
依赖 tools 的具体类型,而它只需要「删了之后通知一声」。

## 三、测试点

1. `mergeLayers`:**没有**任何路径能让 `ResolvedSettings` 带上 `hooks`
   —— 这条在删干净之后由「类型上不存在」保证,不需要单测。
2. 删除后 `pnpm typecheck` 全绿,且**全量测试**不少于删除前的用例数减去 `hooks.test.ts` 的条数
   (防止「顺手删掉了别的东西」)。
3. `SessionService.delete()` 触发 `onDelete` 回调,`release()` **不触发**。
   —— 这条是 C2 的核心,写反了就会把 cron 归还的会话的 run 杀掉。
4. **端到端**:起一条真 run → 删会话 → 进程真的没了。
5. **变异验证**:把 `onDelete` 从 `delete()` 挪到 `release()` → 第 3 条必须红。

## 四、取舍

- **删 hooks 会让「已经写了 hooks 配置的用户」失去一个本来就没生效的功能。**
  代价为零(它从来没生效过),但要在 `docs/features.md` 里说一句,免得有人以为是回退。
- C2 的回调形态让 `SessionService` 多一个可选依赖。可接受:它已经有
  `registerExtraTools` 等好几个同形态的注入点。

## 五、修订记录

- v1(2026-08-14):初稿,交独立子代理评审。
