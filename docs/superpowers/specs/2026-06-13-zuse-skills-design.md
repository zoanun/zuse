# Zuse Skills 系统设计(Phase 14)

> 2026-06-13。对照 cc-haha `src/skills/`(约 4000 行,六大来源/条件激活/hooks/
> fork 执行/权限分级)取轻量版:**SKILL.md 两字段契约 + 双层目录发现 + 单个 Skill
> 工具暴露**。Skills 的本质一句话:把「某类任务的流程知识」从系统提示词里搬出来,
> 按需加载 —— 不用时零 token,用时全文进上下文。

## 1. SKILL.md 契约

```markdown
---
name: code-review          # 可选,缺省取目录名
description: 审查未提交的本地改动,按严重度分级输出问题清单。用户要求 review/审代码时使用。
---

(markdown 正文:这个技能的完整流程指令,模型照着执行)
```

- **frontmatter 只认两个字段**(CC 有 15+ 个:hooks/allowed-tools/model/fork/paths…
  全部 v1 不做):`name` 与 `description`。description 是**触发的全部依据**——
  模型靠它判断"现在该用这个技能",写不好就永远不会被想起。
- 缺 description 时回退取正文第一个 `#` 标题(对齐 CC);连标题都没有 → 该技能
  跳过不加载(没有可触发的依据,加载了也是死技能)。
- 解析用手写的最小 frontmatter 解析器(只支持 `key: 单行值`),不引 yaml 依赖
  ——两个字段用不上完整 YAML,CC 需要它是因为有 15+ 字段含嵌套 hooks。

## 2. 发现与加载

```
~/.zuse/skills/<name>/SKILL.md          用户级(所有项目可用)
<项目链>/.zuse/skills/<name>/SKILL.md   项目级(cwd 向上逐级收集,与 ZUSE.md 同规则)
```

- 启动扫一次(D5 同款:不热加载,新技能重启生效;CC 的运行时动态发现 v1 不做)。
- 同名冲突:**内层覆盖外层**(项目级 > 用户级;monorepo 包级 > 仓库根)——
  与 ZUSE.md 的"内层更具体权重更高"同一原则,但技能是整体替换不是叠加。
- 损坏/缺 SKILL.md 的目录静默跳过(一个坏技能不能毁掉加载)。

## 3. 暴露给模型(Skill 工具)

- 单个 `Skill` 工具,input = `{ name }`;**工具 description 动态拼出技能清单**
  (`- name: description 截 200 字符`)。CC 用 system-reminder 附件逐轮注入清单
  + 1% 窗口预算;zuse 的清单放工具描述里 —— 工具定义本就是系统级稳定前缀,
  与 prompt cache 天然相容,且不用每轮重发。
- 调用返回:`Base directory: <技能目录绝对路径>` 一行 + SKILL.md 正文(行边界
  截 20k)。正文里的 `${ZUSE_SKILL_DIR}` 展开为技能目录(Windows 反斜杠转正斜杠,
  对齐 CC)——技能可以引用自己目录下的附属文件(参考文档/模板),模型用 Read
  按需取,这是"分层加载"的第二层。
- **readOnly: true**:读一段指令文本,无副作用,免确认(CC 的"安全属性自动允"
  在 v1 等价于全自动允,因为我们没有那些危险字段)。
- 触发指引写在工具描述开头(对齐 CC 的措辞,这是「匹配触发」的机制核心):
  用户请求与某技能匹配时,**先调 Skill 再作答**;不要嘴上提技能而不调用。
- 无技能时不注册该工具(空清单是噪音)。

## 4. 用户侧

- `/skills`:列出已加载技能(名字 + 描述 + 来源层)。
- **v1 不做** `/技能名` 直接调用(CC 的 user-invocable):zuse 的斜杠命令表是
  静态的,动态注册技能命令要动菜单/补全/解析三处;先靠用户口头让模型调
  ("用 code-review 技能审一下")。记 backlog。

## 5. 有意不做清单(对照 CC 砍掉的)

| CC 特性 | 不做的理由 |
| --- | --- |
| hooks / allowed-tools / model / effort / fork 执行 | 全是多 Agent 与权限编排的需求,归 Phase 15 后再评估 |
| paths 条件激活 + 运行时动态发现 | 技能数量级 <20 时,全量列出比条件隐藏简单且无害 |
| 内联 !`shell` 执行 | 在提示词阶段执行命令是个大出错面;技能正文让模型自己调 Bash 即可 |
| bundled / plugin / MCP 来源 | zuse 没有插件系统 |
| 清单 1% 窗口预算 + 截断 | 工具描述里每条 description 截 200 字符已是等价护栏 |

## 6. 测试清单

- 解析:两字段、缺 name 取目录名、缺 description 回退 # 标题、全缺跳过、frontmatter 损坏跳过。
- 发现:用户级 + 项目级向上收集、内层覆盖外层同名、坏目录静默跳过。
- 工具:描述含清单与触发指引;run 返回 Base directory + 展开 ${ZUSE_SKILL_DIR};
  未知技能名回 observation(列可用清单);超长正文行边界截断;readOnly。
- registry:无技能不注册;/skills 列表输出。
