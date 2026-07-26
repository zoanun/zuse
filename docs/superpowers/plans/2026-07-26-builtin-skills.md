# 内置 skill（zuse-config / zuse-readme）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 zuse 两个编译进产物的内置 skill —— `zuse-config`（改自身配置：MCP/skill/cron/设置/人设，含生效时机）与 `zuse-readme`（身份/架构 + 指向仓库权威文档），让 zuse 不再瞎猜自己。

**Architecture:** `packages/tools/src/builtin-skills.ts` 导出 `BUILTIN_SKILLS`（name/description/body 三个字符串常量，body 写死）；`scanSkills` 以**最低优先级** seed 进 map（同名用户/项目 skill 完全覆盖）；`SkillEntry.builtin` 标记让 Skill 工具跳过重读盘与 `Base directory:` 前缀；server/web 把 `source:'builtin'` 呈现为只读（可启停、不可编辑）。server/tui 的 tsup 都 `noExternal: [/^@zuse\//]`，故常量自动随 dist 走，**无需任何打包改动**。

**Tech Stack:** TypeScript（纯）、vitest、React 19、现有 tools/protocol/server/web 分层。

**Spec:** `docs/superpowers/specs/2026-07-26-builtin-skills-design.md`（§4.3 / §4.5 是两个 skill 正文的内容规格，Task 2/3 逐条落成散文）。

**分支**：从 master 切 `builtin-skills`。

**约束**：不引 `@zuse/core` 值进 web；server 无 test 脚本 → 根 vitest；web 测试包内跑；`noUncheckedIndexedAccess: true`（数组下标要守卫）。

---

## Task 1：机制 —— BUILTIN_SKILLS + scanSkills seed + Skill 工具内置分支

**Files:**
- Create: `packages/tools/src/builtin-skills.ts`
- Modify: `packages/tools/src/skills.ts`（`SkillEntry` 加 `builtin`、`scanSkills` seed、`createSkillTool.run` 分支）
- Modify: `packages/tools/src/index.ts`（导出 `BUILTIN_SKILLS`、`BuiltinSkill`）
- Test: `packages/tools/src/skills.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**（追加到 `skills.test.ts` 末尾；沿用该文件既有的 tmpdir/home/cwd helper 写法）

```ts
describe('builtin skills', () => {
  it('scanSkills 默认带上内置技能（builtin:true, dir 为空）', () => {
    const { home, cwd } = makeDirs()            // 空目录：磁盘上没有任何 skill
    const skills = scanSkills(home, cwd)
    const cfg = skills.find((s) => s.name === 'zuse-config')
    const readme = skills.find((s) => s.name === 'zuse-readme')
    expect(cfg?.builtin).toBe(true)
    expect(cfg?.dir).toBe('')
    expect(cfg?.description).toMatch(/config/i)
    expect(readme?.builtin).toBe(true)
    expect(readme?.body.length).toBeGreaterThan(200)
  })

  it('同名用户技能完全覆盖内置', () => {
    const { home, cwd } = makeDirs()
    writeSkill(join(home, '.zuse', 'skills'), 'zuse-config', '我自己的版本', 'MY BODY')
    const found = scanSkills(home, cwd).filter((s) => s.name === 'zuse-config')
    expect(found).toHaveLength(1)
    expect(found[0]!.builtin).toBeUndefined()
    expect(found[0]!.body).toContain('MY BODY')
  })

  it('Skill 工具加载内置：返回正文、无 Base directory 前缀、不因无文件报错', async () => {
    const { home, cwd } = makeDirs()
    const tool = createSkillTool(scanSkills(home, cwd))
    const res = await tool.run({ name: 'zuse-readme' })
    expect(res.isError).toBeFalsy()
    expect(res.output).not.toContain('Base directory:')
    expect(res.output).toContain('zuse')
  })

  it('没有磁盘技能时 Skill 工具仍启用（内置令清单非空）', () => {
    const { home, cwd } = makeDirs()
    expect(toolModule.enabled?.({ skills: scanSkills(home, cwd) } as never)).toBe(true)
  })
})
```

> `makeDirs`/`writeSkill` 用该测试文件已有的等价 helper（先读文件，按其命名调整）；`toolModule` 从 `./skills.js` 导入。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/tools/src/skills.test.ts`
Expected: FAIL（`zuse-config` 未定义 / `builtin` 不存在）

- [ ] **Step 3: 建 `builtin-skills.ts`（骨架 + 两个占位 body，正文在 Task 2/3 填）**

```ts
/**
 * 内置技能：编译进产物、随包发布，任何 cwd 都在，用户无需安装。
 * 镜像 builtin-tools 的显式数组模式——加一个内置技能 = 往 BUILTIN_SKILLS 加一项。
 * 它们在 scanSkills 里以最低优先级 seed，同名的用户/项目技能可整体覆盖。
 * 设计见 docs/superpowers/specs/2026-07-26-builtin-skills-design.md。
 */
export interface BuiltinSkill {
  name: string
  description: string
  body: string
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { name: 'zuse-config', description: ZUSE_CONFIG_DESCRIPTION, body: ZUSE_CONFIG_BODY },
  { name: 'zuse-readme', description: ZUSE_README_DESCRIPTION, body: ZUSE_README_BODY },
]
```
（`ZUSE_*` 四个常量在本文件内以模板字符串定义；Task 2/3 写正文。）

- [ ] **Step 4: 改 `skills.ts`**

`SkillEntry` 加字段：
```ts
  /** true = 编译进产物的内置技能（无磁盘文件：不可编辑、不重读盘、无 Base directory）。 */
  builtin?: true
```
`scanSkills` 顶部 seed（保持 user→project 覆盖顺序不变）：
```ts
export function scanSkills(home: string, cwd: string): SkillEntry[] {
  const map = new Map<string, SkillEntry>()
  // 内置技能最低优先级：同名的用户/项目技能整体覆盖它（逃生舱）。
  for (const s of BUILTIN_SKILLS) map.set(s.name, { name: s.name, description: s.description, dir: '', body: s.body, builtin: true })
  scanRoot(join(home, '.zuse', 'skills'), map)
  for (const dir of ancestorChain(cwd)) scanRoot(join(dir, '.zuse', 'skills'), map)
  return [...map.values()]
}
```
`createSkillTool.run()` 在找到 skill 之后、重读盘之前分支：
```ts
      // 内置技能没有磁盘文件：不重读盘、不展开 ${ZUSE_SKILL_DIR}、不给 Base directory
      //（指向一个不存在的目录会诱导模型去 Read 它）。
      if (skill.builtin) return { output: capAtLineBoundary(skill.body, SKILL_BODY_CAP) }
```

- [ ] **Step 5: 导出**（`packages/tools/src/index.ts`，跟在现有 skills 导出后）

```ts
export { BUILTIN_SKILLS, type BuiltinSkill } from './builtin-skills.js'
```

- [ ] **Step 6: 跑测试 + typecheck**

Run: `pnpm exec vitest run packages/tools/src/skills.test.ts`
Expected: PASS（含 4 条新用例）
Run: `pnpm --filter @zuse/tools exec tsc --noEmit`
Expected: EXIT 0

- [ ] **Step 7: Commit**

```bash
git add packages/tools/src/builtin-skills.ts packages/tools/src/skills.ts packages/tools/src/index.ts packages/tools/src/skills.test.ts
git commit -m "feat(tools): BUILTIN_SKILLS mechanism — compiled-in skills seeded at lowest precedence"
```

---

## Task 2：`zuse-config` 正文

**Files:**
- Modify: `packages/tools/src/builtin-skills.ts`（`ZUSE_CONFIG_DESCRIPTION` + `ZUSE_CONFIG_BODY`）
- Test: `packages/tools/src/builtin-skills.test.ts`（新建）

**内容规格**：spec §4.2（description 原文）与 §4.3（正文要点）逐条落成 Markdown 散文。**必须覆盖**（都是已核实事实，不得凭记忆改写）：

- 设置三层 + `.jsonc` 优先于 `.json`：`~/.zuse/settings.json[c]` → `<项目根>/.zuse/settings.json[c]` → `<项目根>/.zuse/settings.local.json[c]`（本地层优先级最高、放 apiKey/model/permissions）
- 常用键：`model` / `smallModel` / `imageModel` / `providers{apiKey,baseURL,models[],contextWindow,protocol}` / `permissions{defaultMode,allow,ask,deny}` / `mcpServers{}` / `webSearch`
- MCP：连接在 daemon 启动时建 → 重启生效，或 Web MCP 面板 reconnect（实时）
- Skill：`~/.zuse/skills/<名>/SKILL.md` 与项目级 `.zuse/skills/`；frontmatter 只认 name/description；`${ZUSE_SKILL_DIR}`；启停在 `~/.zuse/skills-disabled.json`；内置只能启停不能编辑
- Cron：**别手改 `~/.zuse/cron/tasks.json`**（调度器持内存 croner 定时器，手改不重排）；走 Web「⏰ 定时任务」面板或 `/api/cron`（含 `POST /api/cron/<id>/run`）立即生效；字段 name/cron(5 段)/prompt/cwd/permissionMode/enabled；每次触发开全新会话
- 人设 `~/.zuse/personas.json`（新会话生效）；`SYSTEM.md`/`ZUSE.md`/`MEMORY.md`/`memory.db`（用 Memory 工具或面板，别手写 db）
- 其它目录：`web-sessions/`、`uploads/`、`web-auth.json`
- **生效时机速查表**（spec §4.3 的表格，逐行落地）
- 收尾要求：改完明确告知用户何时生效、需不需要重启

- [ ] **Step 1: 写失败测试**（新建 `builtin-skills.test.ts`）

```ts
import { describe, it, expect } from 'vitest'
import { BUILTIN_SKILLS } from './builtin-skills.js'

const bySkill = (n: string) => BUILTIN_SKILLS.find((s) => s.name === n)!

describe('zuse-config builtin skill', () => {
  const s = () => bySkill('zuse-config')
  it('description 覆盖全部触发场景', () => {
    const d = s().description.toLowerCase()
    for (const kw of ['mcp', 'skill', 'cron', 'model', 'permission', 'persona', 'settings']) {
      expect(d).toContain(kw)
    }
  })
  it('正文写清各配置路径', () => {
    const b = s().body
    for (const p of ['~/.zuse/settings.json', 'settings.local.json', '~/.zuse/skills/', '~/.zuse/cron/tasks.json', 'personas.json', 'skills-disabled.json']) {
      expect(b).toContain(p)
    }
  })
  it('正文讲清生效时机（重启 / 新会话 / 面板实时）与 cron 手改陷阱', () => {
    const b = s().body
    expect(b).toContain('/api/cron')
    expect(b).toMatch(/重启/)
    expect(b).toMatch(/新会话/)
    expect(b).toMatch(/生效/)
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/tools/src/builtin-skills.test.ts`
Expected: FAIL（占位 body 不含这些内容）

- [ ] **Step 3: 写 `ZUSE_CONFIG_DESCRIPTION` + `ZUSE_CONFIG_BODY`**

description 用 spec §4.2 的英文原文（英文与其它工具描述一致，便于模型匹配）。body 用**中文 Markdown**（与用户交流语言一致），按 spec §4.3 全部要点组织，含生效时机表格。模板字符串里出现的反引号与 `${` 需转义。

- [ ] **Step 4: 跑确认通过**

Run: `pnpm exec vitest run packages/tools/src/builtin-skills.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/builtin-skills.ts packages/tools/src/builtin-skills.test.ts
git commit -m "feat(tools): zuse-config builtin skill — config locations, formats, and when changes take effect"
```

---

## Task 3：`zuse-readme` 正文

**Files:**
- Modify: `packages/tools/src/builtin-skills.ts`（`ZUSE_README_DESCRIPTION` + `ZUSE_README_BODY`）
- Test: `packages/tools/src/builtin-skills.test.ts`（追加 describe）

**内容规格**：spec §4.4（description）与 §4.5（正文要点）。**必须覆盖**：身份（从零手写 coding agent、TS/Node22/pnpm monorepo、TUI + Web UI 两个界面）；6 个包职责表；粗线条能力概览；**权威来源顺序**（`ls docs/superpowers/specs/` → 两份 roadmap → `packages/*/src` 是 ground truth → plans → README.md）；**诚实约束**（自述可能滞后、只有在 zuse 仓库里才能深答、答机制要带文件路径）。

- [ ] **Step 1: 写失败测试**（追加）

```ts
describe('zuse-readme builtin skill', () => {
  const s = () => bySkill('zuse-readme')
  it('description 覆盖身份类提问', () => {
    const d = s().description.toLowerCase()
    for (const kw of ['who', 'architecture', 'zuse']) expect(d).toContain(kw)
  })
  it('正文含包结构与身份', () => {
    const b = s().body
    for (const p of ['packages/core', 'packages/tools', 'packages/protocol', 'packages/server', 'packages/web', 'packages/tui']) {
      expect(b).toContain(p)
    }
  })
  it('正文指向权威来源并诚实声明局限', () => {
    const b = s().body
    expect(b).toContain('docs/superpowers/specs/')
    expect(b).toContain('README.md')
    expect(b).toMatch(/ground truth|以代码为准/)
    expect(b).toMatch(/滞后|可能过时/)
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/tools/src/builtin-skills.test.ts`
Expected: FAIL

- [ ] **Step 3: 写两个常量**（同 Task 2 的语言约定：description 英文、body 中文 Markdown）

- [ ] **Step 4: 跑确认通过 + tools 全量**

Run: `pnpm exec vitest run packages/tools`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/builtin-skills.ts packages/tools/src/builtin-skills.test.ts
git commit -m "feat(tools): zuse-readme builtin skill — identity, package map, authoritative-source pointers"
```

---

## Task 4：server —— `source:'builtin'` + 拒绝编辑内置

**Files:**
- Modify: `packages/protocol/src/index.ts`（`SkillItem.source` 加 `'builtin'`）
- Modify: `packages/server/src/skill/SkillService.ts`（list 判 builtin；update 拒编辑）
- Modify: `packages/server/src/http/server.ts`（PATCH /api/skills/<name> 捕获该错 → 400）
- Test: `packages/server/src/skill/SkillService.test.ts`

- [ ] **Step 1: 写失败测试**（追加，沿用该文件既有 helper）

```ts
it("内置技能标成 source:'builtin'（不是 project）", async () => {
  const svc = new SkillService({ home, cwd, disabledFile })
  const item = (await svc.list()).skills.find((s) => s.name === 'zuse-config')!
  expect(item.source).toBe('builtin')
})

it('拒绝编辑内置技能的正文/描述', async () => {
  const svc = new SkillService({ home, cwd, disabledFile })
  await expect(svc.update('zuse-config', { body: 'hacked' })).rejects.toThrow(/builtin/i)
})

it('允许启停内置技能', async () => {
  const svc = new SkillService({ home, cwd, disabledFile })
  const item = await svc.update('zuse-config', { enabled: false })
  expect(item!.enabled).toBe(false)
})
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm exec vitest run packages/server/src/skill/SkillService.test.ts`
Expected: FAIL

- [ ] **Step 3: protocol 改类型**

```ts
  /** user = ~/.zuse/skills; project = a .zuse/skills along the cwd chain; builtin = compiled into zuse. */
  source: 'user' | 'project' | 'builtin'
```

- [ ] **Step 4: SkillService 改 list + update**

list 的 map 里：
```ts
      source: s.builtin ? 'builtin' : (resolve(s.dir).startsWith(userRoot) ? 'user' : 'project'),
```
> 注意：内置 `dir:''`，`resolve('')` 会得到进程 cwd → 不显式判 builtin 会被误标成 project。

update 顶部（找到 entry 之后）：
```ts
    // 内置技能没有磁盘文件：正文/描述不可编辑（要改就在 ~/.zuse/skills/ 建同名技能整体覆盖）。
    // enabled 仍可切——禁用列表按名字存，对内置同样适用。
    if (entry.builtin && (fields.description !== undefined || fields.body !== undefined)) {
      throw new Error(`Cannot edit builtin skill "${name}": create a same-named skill under ~/.zuse/skills/ to override it.`)
    }
```

- [ ] **Step 5: 路由捕获 → 400**（`http/server.ts` 的 `PATCH /api/skills/` 分支，把 `deps.skill.update(...)` 包进 try/catch）

```ts
      try { const item = await deps.skill.update(name, body); return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: { code: 'not_found', message: 'skill not found' } }) }
      catch (e) { return sendJson(res, 400, { error: { code: 'bad_request', message: e instanceof Error ? e.message : String(e) } }) }
```
（先读该分支现状，保持既有 404/校验行为不变。）

- [ ] **Step 6: 跑测试 + typecheck**

Run: `pnpm exec vitest run packages/server`
Expected: PASS（`SessionService.test` 并行 flaky 则隔离重跑取证）
Run: `pnpm --filter @zuse/protocol exec tsc --noEmit` 与 `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 均 EXIT 0

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/index.ts packages/server/src/skill/SkillService.ts packages/server/src/http/server.ts packages/server/src/skill/SkillService.test.ts
git commit -m "feat(server): expose builtin skills as source:'builtin' (toggleable, not editable)"
```

---

## Task 5：web —— builtin 只读呈现

**Files:**
- Modify: `packages/web/src/components/SkillsPanel.tsx`（builtin 不渲染 ✎）
- Modify: `packages/web/src/styles.css`（`.skill-src-builtin` 徽章样式，仿现有 `.skill-src-user/.skill-src-project`）
- Test: `packages/web/src/components/SkillsPanel.test.tsx`（若不存在则新建）

- [ ] **Step 1: 写失败测试**

```tsx
it('内置技能：显示 builtin 徽章、无编辑按钮、仍可启停', () => {
  const items = [{ name: 'zuse-config', description: 'd', body: 'b', source: 'builtin' as const, enabled: true }]
  render(<SkillsPanel state={{ skills: items }} onUpdate={() => {}} />)   // props 按组件实际签名调整
  expect(screen.getByText('builtin')).toBeInTheDocument()
  expect(screen.queryByLabelText('编辑技能')).not.toBeInTheDocument()
  expect(screen.getByLabelText('禁用技能')).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑确认失败**

Run: `cd packages/web ; pnpm exec vitest run src/components/SkillsPanel.test.tsx`
Expected: FAIL

- [ ] **Step 3: 组件改动**（编辑按钮外包一层条件）

```tsx
{item.source === 'builtin' ? null : (
  <button className="mem-edit" title="编辑" aria-label="编辑技能" onClick={onEdit}>✎</button>
)}
```
并在提示文案里补一句：内置技能可启停、不可编辑（要改建同名技能覆盖）。

- [ ] **Step 4: 样式**（`styles.css` 仿现有徽章色，加 `.skill-src-builtin`）

- [ ] **Step 5: 跑确认通过 + web 全量 + typecheck**

Run: `cd packages/web ; pnpm exec vitest run`
Expected: PASS
Run: `pnpm --filter @zuse/web exec tsc --noEmit`
Expected: EXIT 0

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/SkillsPanel.tsx packages/web/src/components/SkillsPanel.test.tsx packages/web/src/styles.css
git commit -m "feat(web): render builtin skills read-only (badge + no edit, toggle kept)"
```

---

## Task 6：/ship

- [ ] **Step 1: 调用 ship 技能**，参数：

`分支 builtin-skills → 本地 master。内置 skill（zuse-config/zuse-readme），横切 tools/protocol/server/web。重点核对:①BUILTIN_SKILLS 最低优先级 seed、同名用户/项目 skill 完全覆盖 ②Skill 工具对 builtin 跳过重读盘+无 Base directory 前缀 ③SkillService.list 显式判 builtin（dir:'' 经 resolve 会误判 project）、update 拒编辑内置但允许启停、路由 400 ④web builtin 只读呈现 ⑤两个 skill 正文里的路径/生效时机是否与代码事实一致（settings 三层 .jsonc 优先、cron 手改 tasks.json 不重排、MCP 重启或面板 reconnect）。web 有改动→Playwright(密码 zuonaok):管理→技能面板出现 zuse-config/zuse-readme 带 builtin 徽章无 ✎、可启停；并在聊天里问「你的定时任务是怎么实现的」验证模型先调 Skill(zuse-readme) 再读仓库文档作答。server 无 test 脚本用根 vitest；web 测试包内跑；SessionService.test 并行 flaky 则隔离重跑取证。`

---

## Self-Review

**1. Spec 覆盖**：§3.1 BUILTIN_SKILLS→T1；§3.2 builtin 标记→T1；§3.3 seed→T1；§3.4 工具分支→T1；§3.5 服务端/前端→T4/T5；§4.2-4.3 zuse-config→T2；§4.4-4.5 zuse-readme→T3；§5 测试→各 Task 的 TDD + T6 Playwright。✓

**2. 占位符扫描**：无 TBD。两个 skill 正文以"内容规格 + 必测关键词"的形式给定（正文是散文，测试锁定必须出现的路径/概念），而非"自由发挥"。

**3. 类型一致性**：`BuiltinSkill{name,description,body}`（T1 定义）与 `SkillEntry.builtin?: true`（T1）在 T4 的 `s.builtin` 判定处一致；`SkillItem.source` 三值（T4 protocol）与 web 的 `source === 'builtin'`（T5）一致。
