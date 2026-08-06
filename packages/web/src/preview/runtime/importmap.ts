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
})

export function importMapJson(): string {
  return JSON.stringify({ imports: PREVIEW_IMPORT_MAP })
}

/** 不在表里的裸包名。用于给出可读提示。 */
export function unknownPackages(specifiers: string[]): string[] {
  return specifiers.filter((s) => !(s in PREVIEW_IMPORT_MAP))
}
