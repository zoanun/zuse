// 造 iframe 预览用的 vendor 产物（dist/preview-vendor/）。
//
// **入口清单驱动**：加一个框架 = 往 VENDOR 表里加一行，不改流程本体（设计 §8.1）。
// 这条约束不是洁癖 —— 两个框架的形状本来就不同：
//   - React 19 **不发布任何浏览器可直接加载的构建**（实测 packages/web 解析到 19.2.7，
//     无 umd/、无 esm-browser），必须自己 bundle 成 ESM。
//   - Vue 相反，`vue.runtime.esm-browser.prod.js` 开箱即用，只需拷贝。
// 若按「先只做 React」的形状建这套流程，PR2 接 Vue 时必然推倒重来。
import { build } from 'esbuild'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = resolve(root, 'dist', 'preview-vendor')

/**
 * React 三个入口必须共用**同一个 React 实例**，否则 hooks 的 dispatcher 对不上 ——
 * 症状是模块能解析、组件能开始渲染，一调 hook 就报
 * `Cannot read properties of null (reading 'useState')`，报错位置在 React 内部、看不出根因。
 *
 * 走过两条死路，记在这里免得有人再试：
 * 1. 三个各自 `bundle` → 各带一份 React 副本 → 上面那个 dispatcher 错。
 * 2. 给 react-dom 加 `external:['react']` → react-dom 是 CJS，它内部是 `require('react')`，
 *    esbuild 在 esm 输出下把它编成**动态 require 垫片**，浏览器里直接抛。
 *
 * 可行的做法：把三者打进**一个** core bundle（内部天然只有一份 React），
 * 再生成三个薄转发层指向它。转发层的导出名在构建时 require 一次枚举出来，
 * 不能写 `export *` —— React 全家都是 CJS，`export *` 不为 CJS 静态转出具名导出，
 * 产物里 `jsx` 之类根本不存在（症状：`does not provide an export named 'jsx'`）。
 */
const REACT_CORE = 'react-core.js'

const CORE_SOURCE = `
import * as R from 'react'
import * as RD from 'react-dom/client'
import * as JR from 'react/jsx-runtime'
const pick = (ns) => (ns && ns.__esModule ? ns.default ?? ns : ns.default ?? ns)
export const react = pick(R)
export const reactDomClient = pick(RD)
export const jsxRuntime = pick(JR)
`

/** 枚举一个 CJS 包的合法具名导出。 */
function namesOf(pkg) {
  const mod = require(pkg)
  return Object.keys(mod).filter((k) => k !== 'default' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k))
}

/** 生成一个指向 core 的薄转发层源码。 */
function shimSource(exportName, pkg) {
  return [
    `import { ${exportName} as __m } from './${REACT_CORE}'`,
    ...namesOf(pkg).map((n) => `export const ${n} = __m[${JSON.stringify(n)}]`),
    `export default __m`,
  ].join('\n')
}

/** 每项要么 shim（转发到 core），要么 copy（从 node_modules 拷现成产物）。 */
const VENDOR = [
  { out: 'react.js', mode: 'shim', exportName: 'react', pkg: 'react' },
  { out: 'react-jsx-runtime.js', mode: 'shim', exportName: 'jsxRuntime', pkg: 'react/jsx-runtime' },
  { out: 'react-dom-client.js', mode: 'shim', exportName: 'reactDomClient', pkg: 'react-dom/client' },
  // PR2 追加（形状已支持，不改流程）：
  // { out: 'vue.js', mode: 'copy', from: 'vue/dist/vue.runtime.esm-browser.prod.js' },
]

await mkdir(outDir, { recursive: true })

// 先出 core：三个 shim 都 import 它，所以它必须存在且只有一份。
await build({
  stdin: { contents: CORE_SOURCE, resolveDir: root, loader: 'js' },
  bundle: true,
  format: 'esm',
  minify: true,
  // 预览产物按生产模式打包：dev 版会拖进 React 的开发期警告与体积。
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: resolve(outDir, REACT_CORE),
})
console.log(`[preview-vendor] bundle ${REACT_CORE}`)

for (const item of VENDOR) {
  const outfile = resolve(outDir, item.out)
  if (item.mode === 'copy') {
    await copyFile(require.resolve(item.from), outfile)
    console.log(`[preview-vendor] copy  ${item.out}`)
    continue
  }
  // shim 不过 esbuild：它就是几行静态 ESM，打包只会把 core 又内联进来（那就白拆了）。
  await writeFile(outfile, shimSource(item.exportName, item.pkg))
  console.log(`[preview-vendor] shim  ${item.out}`)
}
