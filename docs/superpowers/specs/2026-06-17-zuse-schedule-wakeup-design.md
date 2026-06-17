# ScheduleWakeup 设计文档（Phase 16）

> **日期**: 2026-06-17
> **状态**: 设计完成，待实现
> **依赖**: tool.ts (Tool)、useConversation (TUI agent loop 入口)

---

## 1. 目标

让模型能设置一个延时定时器，到时间后自动向当前会话注入一条消息，触发新一轮 agent loop。

典型场景：跑完构建后等 CI、轮询部署状态、定时检查外部资源。

## 2. 工具接口

### Input Schema

```typescript
{
  delaySeconds: number  // 延时秒数，1-3600，超范围 clamp
  message: string       // 唤醒时注入的 user message 文本
}
```

### Output

`"已设置 {N} 秒后唤醒: {message}"` — 确认文本，`isError: false`。

### 工具描述（给模型看）

```
Schedule a delayed self-wakeup. After delaySeconds, the message is injected as a
user message and triggers a new agent turn. Use this to poll external state (CI,
deploy, build) without blocking. Only one pending wakeup at a time — a new call
replaces the previous one.
```

## 3. 运行机制

```
模型: tool_use { name: "ScheduleWakeup", input: { delaySeconds: 60, message: "检查 CI" } }

Zuse:
  1. 调 deps.onSchedule(delayMs, message)
  2. TUI 层: clearTimeout 旧定时器 → setTimeout(delayMs) → 到时间调 submit(message)
  3. 返回 tool_result 确认
  4. 本回合正常结束

  ... 60 秒后 ...

  5. submit("⏰ 定时唤醒: 检查 CI") — 等同用户手动发消息
  6. 新一轮 agent loop 启动
```

### 依赖注入

```typescript
interface ScheduleWakeupDeps {
  onSchedule: (delayMs: number, message: string) => void
}

function createScheduleWakeupTool(deps: ScheduleWakeupDeps): Tool
```

TUI 层在 useConversation 中注册，`onSchedule` 回调持有 `submit` 引用和定时器 ref。

## 4. 约束

- **一次只允许一个 pending wakeup**：新调用 clearTimeout 旧的再设新的
- **delaySeconds clamp 到 [1, 3600]**：防止 0 秒死循环和超长等待
- **进程退出即失效**：不持久化，纯内存 setTimeout
- **唤醒消息带 ⏰ 前缀**：让模型和用户都能识别这是定时触发而非手动输入

## 5. 文件结构

```
packages/tools/src/schedule-wakeup.ts       — Tool 实现
packages/tools/src/schedule-wakeup.test.ts  — 单测
packages/tools/src/index.ts                 — 导出
packages/tui/src/hooks/useConversation.ts   — 注册 + onSchedule 回调
```

## 6. 测试策略

- **Tool 单测**（mock onSchedule）：验证 delayMs 计算、message 传递、clamp 行为、返回文本
- **不做 e2e**：setTimeout + submit 联动在 TUI 层，靠手动验证
