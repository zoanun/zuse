import type { PreviewKind } from '../types.js'

/**
 * sucrase 的转换开关。
 *
 * **`jsxRuntime:'automatic'` + `production:true` 是定死的，不是随手填的**（设计 §2.3）。
 * 三种模式的实测输出：
 *
 * - 默认 `classic` → `React.createElement(...)`，**要求 guest 作用域里有 `React` 绑定**。
 *   而模型写 JSX 常常不写 `import React`（React 17+ 起就不需要了）→ `React is not defined`。
 * - `automatic` → `import {jsxDEV} from "react/jsx-dev-runtime"` —— 注意是 **dev** runtime，
 *   不在我们的 import map 里 → 模块解析失败。还会注入 `__self`/`__source` 噪音。
 * - `automatic` + `production` → `import {jsx} from "react/jsx-runtime"` ✅ 正是 map 里那一项。
 */
function transformsFor(kind: PreviewKind): { transforms: Array<'typescript' | 'jsx'> } {
  switch (kind) {
    case 'ts': return { transforms: ['typescript'] }
    case 'jsx': return { transforms: ['jsx'] }
    case 'tsx': return { transforms: ['typescript', 'jsx'] }
    default: return { transforms: [] }
  }
}

/**
 * TS/JSX/TSX → 可直接进 `<script type="module">` 的 JS。
 *
 * sucrase 是**懒加载**的：大多数会话根本不会用到预览，不该让首屏背这 46 KB。
 */
export async function transformScript(code: string, kind: PreviewKind): Promise<string> {
  const { transforms } = transformsFor(kind)
  if (transforms.length === 0) return code
  const { transform } = await import('sucrase')
  return transform(code, { transforms, jsxRuntime: 'automatic', production: true }).code
}

/**
 * 扫出裸包名 import，用于给出比浏览器原生「Failed to resolve module specifier」更可读的提示。
 *
 * **只是补充，不是闸门**：动态 `import()` 与拼接出来的说明符扫不到，那些仍然由 guest 侧
 * 运行时报错兜底（设计 §6）。相对路径与 URL 不算裸包名。
 */
export function scanBareImports(code: string): string[] {
  const found = new Set<string>()
  const re = /(?:^|[\s;}])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] ?? m[2]
    if (!spec) continue
    if (spec.startsWith('.') || spec.startsWith('/') || /^[a-z]+:/i.test(spec)) continue
    found.add(spec)
  }
  return [...found]
}
