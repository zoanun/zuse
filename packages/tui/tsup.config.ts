import { defineConfig } from 'tsup'

// 预编译产物配置：把整棵 TS 转译 + 打包成 dist/index.js,启动时不再现场用 tsx 转译,
// 冷启动显著变快。日常开发仍走 `pnpm dev`(tsx),改完即生效无需 build。
export default defineConfig({
  entry: { index: 'src/index.tsx' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // CLI 产物不需要 .d.ts;关掉省构建时间。
  dts: false,
  sourcemap: true,
  // 可执行产物的 node shebang(源文件已不再带 shebang,避免与此重复)。
  banner: { js: '#!/usr/bin/env node' },
  // 只把工作区内部包(@zuse/core、@zuse/tools)内联进产物;其余裸模块说明符
  // (ink/react、ripgrep、jsdom、两个大模型 SDK …)全部 external。
  // external 正则:凡不以 `@zuse/` 或 `.`(相对路径)开头的说明符都判为 external——
  // 这样既避免打包 jsdom/ripgrep 这类带原生/二进制资源的依赖,也让 SDK 的懒加载
  // import() 保持运行时动态导入(见 anthropic-client / openai-client)。
  // noExternal 优先级高于 tsup 对 package.json deps 的自动 external,故能强制内联 @zuse/*。
  external: [/^(?!@zuse\/|\.)/],
  noExternal: [/^@zuse\//],
})
