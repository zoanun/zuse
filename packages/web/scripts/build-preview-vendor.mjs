// 造 iframe 预览用的 vendor 产物（dist/preview-vendor/）。
//
// **入口清单驱动**：加一个框架 = 往 VENDOR 表里加一行，不改流程本体（设计 §8.1）。
// 这条约束不是洁癖 —— 两个框架的形状本来就不同：
//   - React 19 **不发布任何浏览器可直接加载的构建**（实测 packages/web 解析到 19.2.7，
//     无 umd/、无 esm-browser），必须自己 bundle 成 ESM。
//   - Vue 相反，`vue.runtime.esm-browser.prod.js` 开箱即用，只需拷贝。
// 若按「先只做 React」的形状建这套流程，PR2 接 Vue 时必然推倒重来。
import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'dist', 'preview-vendor')

/** 每项要么 bundle（从一段入口源码打包），要么 copy（从 node_modules 拷现成产物）。 */
const VENDOR = [
  { out: 'react.js', mode: 'bundle', source: `export * from 'react'; export { default } from 'react';` },
  { out: 'react-jsx-runtime.js', mode: 'bundle', source: `export * from 'react/jsx-runtime';` },
  {
    out: 'react-dom-client.js',
    mode: 'bundle',
    source: `export * from 'react-dom/client'; export { default } from 'react-dom/client';`,
  },
  // PR2 追加（形状已支持，不改流程）：
  // { out: 'vue.js', mode: 'copy', from: 'vue/dist/vue.runtime.esm-browser.prod.js' },
]

await mkdir(outDir, { recursive: true })

for (const item of VENDOR) {
  const outfile = resolve(outDir, item.out)
  if (item.mode === 'copy') {
    await copyFile(require.resolve(item.from), outfile)
    console.log(`[preview-vendor] copy  ${item.out}`)
    continue
  }
  await build({
    stdin: { contents: item.source, resolveDir: resolve(here, '..'), loader: 'js' },
    bundle: true,
    format: 'esm',
    minify: true,
    // 预览产物按生产模式打包：dev 版会拖进 React 的开发期警告与体积。
    define: { 'process.env.NODE_ENV': '"production"' },
    outfile,
  })
  console.log(`[preview-vendor] bundle ${item.out}`)
}
