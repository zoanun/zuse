/**
 * vitest workspace —— 让「全量测试」真的是全量。
 *
 * ## 为什么需要这个文件
 *
 * 根 `vitest.config.ts` 有两道把 web 排除在外的口子，叠在一起，谁也不会同时注意到：
 *
 * ```
 * include: ['packages/*​/src/**​/*.test.ts'],          ← 不含 .tsx，web 的 31 个 .tsx 全不匹配
 * exclude: [..., 'packages/web/**'],                  ← 剩下的 17 个 .ts 被显式排除
 * ```
 *
 * 而 `CLAUDE.md` 把 `npx vitest run --root E:/ai-study/zuse` 写成「全量测试」。实测：
 *
 * ```
 * $ npx vitest list --root E:/ai-study/zuse --filesOnly | wc -l     → 142
 * $ npx vitest list --root E:/ai-study/zuse --filesOnly | grep -c packages/web → 0
 * $ find packages/*​/src -name '*.test.ts' -o -name '*.test.tsx' | wc -l       → 190
 * ```
 *
 * **190 个测试文件里，「全量测试」只跑 142 个。** web 的 48 个文件、545 条用例从来没进过门禁。
 * 这不是理论问题：回溯审计正是在那 48 个文件里找到了 iframe sandbox 的「安全锁」测试
 * ——它断言的是一个模块常量，而不是 iframe 真实的 `sandbox` 属性；删掉应用那个常量的
 * 唯一一行（权限最大化），三条安全测试照样全绿。**门禁跑不到它，是它能一直隐形的原因。**
 *
 * ## 为什么不是「把 exclude 删掉」
 *
 * web 需要 `environment: 'jsdom'`、`@vitejs/plugin-react`（否则 `.tsx` 编译不了）和自己的
 * `setupFiles`；根配置是 `environment: 'node'`。硬并成一个配置要么给所有包套上 jsdom
 * （慢且失真），要么给 web 套上 node（直接跑不起来）。workspace 让两边各用各的配置，
 * 一条命令跑完。
 *
 * **别把根配置里的 `packages/web/**` 排除删掉** —— 有了 workspace，那条排除正是防止
 * web 的测试被 node 环境**重复收集一遍**的东西。
 */
export default [
  // 非 web 包（core / protocol / server / tools / tui）：node 环境，用根配置
  './vitest.config.ts',
  // web：jsdom + react 插件 + setupFiles，用它自己的 vite.config.ts
  './packages/web',
]
