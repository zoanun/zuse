/**
 * guest 里可用的裸包名 → vendor 产物路径。**这是一张封闭的表**，不做 npm 按需拉取（设计 §6）。
 *
 * 注意没有 `react/jsx-dev-runtime`：编译走 `production:true`，产出的是 `jsx-runtime`（§2.3）。
 * 加它等于给 vendor 构建多一个白养的入口。
 */
export const PREVIEW_IMPORT_MAP: Readonly<Record<string, string>> = Object.freeze({
  react: '/preview-vendor/react.js',
  'react-dom': '/preview-vendor/react-dom-client.js',
  'react-dom/client': '/preview-vendor/react-dom-client.js',
  'react/jsx-runtime': '/preview-vendor/react-jsx-runtime.js',
  // runtime-only 构建：SFC 走 inlineTemplate 预编译，guest 不需要模板编译器。
  // 实测比全量构建省 ~21 KB gzip（41 vs 62）。代价是模型偶尔写 `{ template: '...' }`
  // 字符串选项的组件会挂 —— 但那在 SFC 语境下极罕见，且挂时报的是明确的运行时错误。
  vue: '/preview-vendor/vue.js',
})

export function importMapJson(): string {
  return JSON.stringify({ imports: PREVIEW_IMPORT_MAP })
}

/** 不在表里的裸包名。用于给出可读提示。 */
export function unknownPackages(specifiers: string[]): string[] {
  return specifiers.filter((s) => !(s in PREVIEW_IMPORT_MAP))
}
