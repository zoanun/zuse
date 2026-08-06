import type { CompileResult, PreviewSpec } from '../types.js'
import { scanBareImports, transformScript } from './script.js'
import { unknownPackages } from '../runtime/importmap.js'

/**
 * PreviewSpec → 可注入 iframe 的产物。
 *
 * 编译器（sucrase / 将来的 compiler-sfc）全部 `await import(...)` 懒加载 ——
 * 大多数会话用不到预览，不该让首屏背它们的体积。
 */
export async function compile(spec: PreviewSpec): Promise<CompileResult> {
  if (spec.kind === 'html') {
    // HTML 不编译：整段作为 document 写进 iframe（见 buildHtmlSrcdoc）。
    return { js: '', styles: [], errors: [] }
  }

  if (spec.kind === 'vue') {
    // PR2 接。此处明确报未支持，而不是让它掉进 transformScript 被当成普通 JS
    // 静默产出一段跑不起来的东西。
    return { js: '', styles: [], errors: ['Vue SFC 预览尚未接入（A1 PR2）'] }
  }

  const errors: string[] = []
  let js = ''
  try {
    js = await transformScript(spec.code, spec.kind)
  } catch (e) {
    // sucrase 只在真语法错时抛。注意它对 decorators / const enum **不抛**，
    // 那些会原样输出、由浏览器在 guest 里报 SyntaxError（设计 §6）。
    return { js: '', styles: [], errors: [`编译失败：${e instanceof Error ? e.message : String(e)}`] }
  }

  const unknown = unknownPackages(scanBareImports(js))
  for (const pkg of unknown) {
    errors.push(`预览环境里没有 "${pkg}" 这个包，只能用 react / react-dom / vue`)
  }

  return { js, styles: [], errors }
}
