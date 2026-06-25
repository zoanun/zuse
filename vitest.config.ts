import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/web/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts'],
    },
    // ink 的 Text 组件通过 chalk 输出 ANSI 转义码,chalk 在非 TTY 环境默认禁色。
    // 设置 FORCE_COLOR=1 让 chalk 始终输出颜色,使 ink-testing-library 能捕获 ANSI 序列。
    env: {
      FORCE_COLOR: '1',
    },
  },
})
