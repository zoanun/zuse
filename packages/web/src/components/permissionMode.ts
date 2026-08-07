import type { PermissionMode } from '@zuse/protocol'

/**
 * 三档权限模式的展示信息。**文案写机械行为，不写承诺。**
 *
 * 刻意不做的两件事（设计 §2 / §3）：
 *  1. 不去「自动检测 acceptEdits 在当前配置下是否等价于 default 并提示」。等价性依赖 cwd
 *     （路径规则按 cwd 相对化）、依赖工具集（MCP 工具无 specifier，采样不到），
 *     用几个样本去断言「无差别」是会说谎的启发式 —— 偶尔骗人的提示比没有提示更糟。
 *  2. 不宣称全自主档还有多厚的护栏。它之上只剩 deny 表与 Bash 安全检查两道，
 *     而 deny 表是字面前缀匹配（`Bash(rm -rf *)` 拦不住 `rm -fr /`）。
 *     多说一个字，用户就会按那个字去用它。
 *
 * 「询问」档的说明**不能**写成「每次写文件都会问你」：allow 规则在兜底判定之前生效，
 * 本仓库当前的配置里 `Write(./**)` 就在 allow 表里，它根本不问。
 */
export interface PermissionModeInfo {
  mode: PermissionMode
  /** chip 上的短标签。 */
  label: string
  /** 一句话说明它在判定链的哪一步生效。 */
  desc: string
}

export const PERMISSION_MODES: PermissionModeInfo[] = [
  {
    mode: 'default',
    label: '询问',
    desc: '兜底判定：只读工具放行，其余问你。命中 allow 规则的调用在这一步之前就已放行，不会问。',
  },
  {
    mode: 'acceptEdits',
    label: '自动接受编辑',
    desc: '同上，但兜底那一步把 Edit / Write 也算作放行。Bash 等仍会问。',
  },
  {
    mode: 'bypassPermissions',
    label: '全自主',
    desc: 'deny 规则与 Bash 安全检查之后一律放行，不再询问。这两道之外没有别的检查。',
  },
]

export function modeInfo(mode: PermissionMode): PermissionModeInfo {
  return PERMISSION_MODES.find((m) => m.mode === mode) ?? PERMISSION_MODES[0]!
}

/** 点击 chip 的循环顺序：询问 → 自动接受编辑 → 全自主 → 询问。 */
export function nextMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.findIndex((m) => m.mode === mode)
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]!.mode
}
