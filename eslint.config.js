import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', 'pnpm-lock.yaml',
      // **第三方打包产物**（预览用的 React / Vue 运行时）。不排掉的话，
      // 全仓 lint 出来 1190 个 error 里有 1170 个来自这几个压缩过的 vendor 文件 ——
      // 真正属于本仓的问题被埋在里面，等于门禁形同虚设。
      'packages/web/public/preview-vendor/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // **hooks 规则以前一条都没跑过。** web 与 tui 两个包全是 React/Ink 组件，
  // 而「依赖数组漏了一项」「条件里调 hook」这类错误是**测试照不出来**的：
  // 它们表现为「某次不重渲染」「某个 ref 停在旧值」，绿着测试也能长期存在。
  {
    files: ['packages/web/src/**/*.{ts,tsx}', 'packages/tui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // exhaustive-deps 设 warn 不设 error：这条规则的误报（刻意省略依赖以避免重订阅）
      // 在本仓是真实存在的模式，一次性全改成 error 会逼人加 eslint-disable，
      // 那比留一条 warn 更糟 —— disable 注释一旦加上就再也没人回来看。
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
