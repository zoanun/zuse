/** 可预览的产物种类。PR1 覆盖前四种；'vue' 由 PR2 接上（detect 已能识别，compile 会明确报未支持）。 */
export type PreviewKind = 'html' | 'js' | 'ts' | 'jsx' | 'tsx' | 'vue'

/** 一段待预览的代码。 */
export interface PreviewSpec {
  kind: PreviewKind
  code: string
}

/**
 * 一段样式。**PR1 就定成数组 + 可选 scopeId**，不是一段裸字符串 ——
 * Vue 的 scoped 样式要求 scopeId 在 compileScript 与 compileStyleAsync 之间共享，
 * 若 PR1 图省事定成 string，PR2 必然回来改签名（设计 §8.1）。
 */
export interface PreviewStyle {
  code: string
  scopeId?: string
}

/** 编译产物。errors 非空时不进 iframe，直接在控制台面板展示。 */
export interface CompileResult {
  /** 可直接作为 <script type="module"> 注入的 JS。 */
  js: string
  styles: PreviewStyle[]
  errors: string[]
}

/** guest → 父页 的消息。 */
export type GuestMessage =
  | { type: 'ready'; token: string }
  | { type: 'log'; level: LogLevel; args: string[]; token: string }
  | { type: 'error'; message: string; stack?: string; token: string }
  | { type: 'resize'; height: number; token: string }

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

/** 父页 → guest 的消息。 */
export type HostMessage =
  | { type: 'eval'; js: string; styles: PreviewStyle[] }
  | { type: 'theme'; theme: 'light' | 'dark' }

/** 控制台面板里的一行。 */
export interface ConsoleEntry {
  id: number
  level: LogLevel
  text: string
  /** 编译期错误与运行时错误要能区分开 —— 前者是我们的编译管线报的，后者是 guest 抛的。 */
  source: 'compile' | 'runtime'
}
