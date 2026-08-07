/**
 * 进程层 —— 子进程环境构造。
 *
 * 从 `bash.ts` 原样抽出（纯提取重构，逻辑一字未改），见设计 §1。
 */

/**
 * 必须从子进程环境里摘掉的变量。
 *
 * `_VOLTA_TOOL_RECURSION` 是 Volta 的**递归守卫**：它的 node/npm/npx/pnpm shim 在启动
 * 子进程前置上这个标记，用来防止 shim 无限自我调用。但它一旦被继承进 zuse 的 Bash 子 shell，
 * 该 shell 里的 `node` 就不再解析 Volta 钉住的版本，转而去找「系统 node」——
 * Windows 上经 cmd.exe 查不到，于是报「'node' 不是内部或外部命令」。
 *
 * 也就是说：凡是经 `pnpm dev` / `npx` / Volta 全局安装启动的 zuse，**它自己的 Bash 工具
 * 就跑不了 node/npm/npx**。这不是测试环境的怪癖，是真实可复现的产品缺陷。
 *
 * 只摘这一个：它是「父进程是个包管理器 shim」这一事实的泄漏，对子命令没有任何正当含义。
 * 其余变量（NODE_OPTIONS、npm_config_* 等）用户可能是**有意**设置的，无证据地一并摘掉
 * 会引入新的意外行为，故不做。
 */
const STRIPPED_CHILD_ENV_VARS = ['_VOLTA_TOOL_RECURSION'] as const

/**
 * 造子进程环境。无需改动时返回 undefined —— spawn 收到 undefined 会继承 process.env，
 * 这是最省事也最不容易出错的路径（不必逐字复制一份环境）。
 *
 * 将来 run 服务需要「按语言注入 PYTHONUNBUFFERED / PYTHONIOENCODING / JAVA_TOOL_OPTIONS」
 * 以及可选的 env 白名单（设计 §5），此处只保留 tmux 这一个覆盖点、待扩展成通用的
 * overrides 映射。**本次不改**：改签名就等于改 bash.ts 的行为面，超出纯提取的范围。
 */
export function buildChildEnv(tmuxEnv: string | null | undefined): NodeJS.ProcessEnv | undefined {
  const needsStrip = STRIPPED_CHILD_ENV_VARS.some((k) => k in process.env)
  if (!tmuxEnv && !needsStrip) return undefined

  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of STRIPPED_CHILD_ENV_VARS) delete env[k]
  // tmux 套接字隔离：覆盖用户原值，模型的 tmux 命令只动 zuse 自己的 server。
  if (tmuxEnv) env.TMUX = tmuxEnv
  return env
}
