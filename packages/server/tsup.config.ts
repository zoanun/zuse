import { defineConfig } from 'tsup'

// 预编译产物配置：把工作区内部包（@zuse/core、@zuse/tools）内联进 dist，
// 第三方库（ws、better-sqlite3、SDK、undici …）保持 external，作为普通 npm 依赖。
// 这样产物自包含、不再依赖 workspace:* 内部包即可独立发布。
export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // 库消费者需要 import { startServer } 等类型。
  dts: true,
  sourcemap: true,
  // external 正则：凡不以 `@zuse/` 或 `.`（相对路径）开头的说明符都判为 external——
  // 避免打包带原生/二进制资源的依赖（better-sqlite3、ripgrep、jsdom），
  // 也让 SDK 的懒加载 import() 保持运行时动态导入。
  external: [/^(?!@zuse\/|\.)/],
  // noExternal 优先级高于 tsup 对 deps 的自动 external，强制内联 @zuse/*。
  noExternal: [/^@zuse\//],
})
