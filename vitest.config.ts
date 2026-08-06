import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/web/**'],
    environment: 'node',
    // vitest 默认 5000ms 是给纯单测调的，而本套件里有一批测试要**真起子进程**
    // （git-bash + node，见 packages/tools/src/bash.test.ts）和**真读写磁盘**
    // （packages/server 的会话持久化）。130 个文件并行、worker 被饿死时，光是 spawn
    // 一个 shell 就可能花掉数秒 —— 实测这会让 bash/session 那几个文件随机超时，
    // 而且每次红的不是同一条，很容易被当成"偶发"忽略掉。
    //
    // 放宽到 20s **不掩盖真问题**：真卡死照样失败，只是晚一点报。真正被换掉的是
    // "机器慢 → 测试红"这个假信号。
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
