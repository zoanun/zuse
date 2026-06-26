# M2 — 角色/人设提示词 CRUD + 切换（设计）

> **日期**: 2026-06-26 · **依赖**: F3（REST 约定 §5.1）· **状态**: 实现中

## 目标

类似 OpenClaw 的 `USER.md`,但**可定义多个、可自定义、可切换**:

- **核心约束层只读**:`DEFAULT_SYSTEM_PROMPT` + 非 Claude 强制约束(`buildSystemPrompt` 内置),不参与切换,仅展示以保护系统性约束。
- **人设层**:一组命名人设(name + 内容)的完整 CRUD;"切换" = 选哪个**激活**。激活的人设作为**附加 section** 叠加在核心层之上 —— 复用 `buildSystemPrompt(env, sections, modelId)` 现成的 `## title\ncontent` 追加机制,**不改引擎**。
- **查看生效 prompt**:只读视图,拼全各层并标来源(core / env / SYSTEM.md / ZUSE.md / MEMORY.md / Persona)。

## 数据模型

`~/.zuse/personas.json`(原子写,坏文件不崩):
```jsonc
{ "personas": [ { "id": "p1", "name": "Reviewer", "content": "...md...", "createdAt": "...", "updatedAt": "..." } ],
  "activeId": "p1" }   // 无激活 = null
```

协议(`@zuse/protocol`,type-only):`PersonaItem { id, name, content, createdAt, updatedAt }`、`PersonasState { personas: PersonaItem[]; activeId: string | null }`。

## 后端

- `packages/server/src/persona/personaStore.ts` —— JSON 持久化(镜像 sessionStore 原子写 + 路径守卫),`load()/save()`。
- `PersonaService` —— `list()/get()/create()/update()/remove()/activate(id|null)/getActive()`;删除激活项则 activeId→null。
- `createSession`:`loadPromptSections(home,cwd)` 后,若有激活人设,push 一段 `{ title: 'Persona: <name>', content }` 再 `buildSystemPrompt`。**切换只对新建/重置的会话生效**(systemPrompt 在建会话时固定;符合"核心只读 + 人设叠加"语义)。
- REST(§5.1):`GET/POST /api/personas`、`PATCH/DELETE /api/personas/<id>`、`POST /api/personas/<id>/activate`(body `{active:bool}` 或专用端点)、`GET /api/system-prompt`(返回 assembled prompt + 各 section 来源,只读视图)。

## 前端

- `ManageDrawer` nav:Prompts 由 soon → 可用。
- `PersonasPanel`:人设列表(激活高亮 + 切换)、新增/编辑/删除(MemoryForm 式)、"查看当前生效 prompt"折叠只读区。
- `manageApi`:list/create/update/delete/activate personas + getSystemPrompt。

## 非目标

- 不改 `buildSystemPrompt` 引擎、不动核心约束层。
- 不做"对运行中会话热切换 prompt"(v1 仅新会话生效;热切换留 follow-up)。
- 人设不参与 prompt cache 失效分析(内容稳定即稳定)。
