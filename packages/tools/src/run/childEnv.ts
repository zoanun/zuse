/**
 * run 服务的子进程环境构造。
 *
 * ## 白名单不是安全边界，是**凭据过滤器**
 *
 * 实测（设计 §1.2，探针 `probe-run-step2.mjs` 第 ② 段）：往 spawn 传 2 个变量，
 * Windows 上子进程实得 **16 个** —— libuv 在 `make_program_env()` 里强补的那批
 * （COMSPEC / PATHEXT / SYSTEMROOT / USERPROFILE …），我们拿不掉。
 *
 * 所以措辞必须是「**在强制的 16 项之上我们再加什么**」，而不是「我们只放行 N 项」。
 * 好在那 16 项里没有任何 `*_KEY` / `*_TOKEN` / `*_SECRET`，
 * 「不把用户的 API key 泄给子进程」这个目标仍然达成。
 *
 * POSIX 上 `env: {}` 是真的空，白名单在那边更接近真边界 —— 结论只会更强。
 * 但正因为 Windows 有那 16 项兜底，**POSIX 专有的通路变量在本机测不出缺失**
 * （见 POSIX_PASSTHROUGH 的注释），名单里必须显式带上。
 *
 * ## 与 `proc/env.ts` 的关系
 *
 * `proc/env.ts` 的 `buildChildEnv` 是 Bash 工具用的：**继承全部 `process.env`**，
 * 只摘掉一个 Volta 守卫。那是「模型代替用户敲命令」的语义，继承全部环境是对的。
 * 这里是「用户点了运行按钮，跑一段可能来路不明的代码」，语义不同，所以另起一份。
 * 两者并存，互不调用。
 */

/**
 * 通路类 —— 砍掉子进程会**起不来**。两平台通用的那部分。
 *
 * `TZ` 在名单里的理由和别处不同：砍掉不会崩，但日志时间戳、`date`、Java 的
 * `LocalDateTime.now()` 会全部漂到 UTC —— 属于「结果悄悄不一样」那一类。
 */
const COMMON_PASSTHROUGH = [
  'PATH', 'HOME', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
] as const

/**
 * Windows 专有通路类。在 Windows 上这些**本来就会被 libuv 补回来**（实测 16 项里
 * 大半是它们），显式列出来是为了两件事：① POSIX 上跑 Windows 路径的测试不会漏；
 * ② 别人读名单时不必先知道 libuv 的行为才能理解「为什么 SystemRoot 没写却也在」。
 */
const WIN_PASSTHROUGH = [
  'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR',
  'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
] as const

/**
 * POSIX 专有通路类。
 *
 * **这一组在本机（Windows）测不出缺失** —— libuv 的 16 项把窟窿盖住了。
 * 到 Linux/mac 上会直接暴露：没有 `SSL_CERT_FILE` 则 curl / python 找不到证书，
 * 没有 `LD_LIBRARY_PATH` 则动态库找不到，没有 `USER`/`LOGNAME` 则一堆工具
 * 写不出作者信息、算不出缓存路径。属于「本机测不出来」因而最该显式写下的那类。
 */
const POSIX_PASSTHROUGH = [
  'USER', 'LOGNAME', 'SHELL', 'LD_LIBRARY_PATH',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'XDG_CACHE_HOME',
] as const

/**
 * 语义敏感类 —— 砍掉**不会崩，会「结果悄悄不一样」**，比崩了更难查。
 *
 * `JAVA_HOME` 是这一类的典型：本机它与 PATH 上的 JDK 恰好是同一个，所以砍掉
 * **看不出任何差别**；用户两者不同时（装了多版本 JDK 的机器很常见），
 * 砍掉会静默换一个 JDK 去编译，而报错信息不会提一个字。
 */
const SEMANTIC = [
  'JAVA_HOME', 'GRADLE_USER_HOME', 'MAVEN_OPTS', 'M2_HOME',
  'NODE_OPTIONS', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX',
] as const

/** 按前缀整组放行的。npm 把 `.npmrc` 的每一项都摊成 `npm_config_<key>` 传给子进程。 */
const PREFIXES = ['npm_config_'] as const

/**
 * 无论如何都要摘掉的。
 *
 * `_VOLTA_TOOL_RECURSION` 是 Volta shim 的递归守卫。它一旦被继承，子 shell 里的
 * `node` 就不再解析 Volta 钉住的版本、转而去找「系统 node」—— Windows 上经 cmd
 * 查不到，直接报「'node' 不是内部或外部命令」。理由与 `proc/env.ts` 同源，
 * 那边有完整的来龙去脉，别在两处各写一遍。
 */
const STRIPPED = ['_VOLTA_TOOL_RECURSION'] as const

export interface RunEnvOptions {
  /** 平台，默认取 `process.platform`。显式传入仅供测试跑另一条分支。 */
  platform?: NodeJS.Platform
}

/**
 * 按名单从 `base` 里挑，再叠加 runner 自己声明的变量。
 *
 * `declared`（`PYTHONUNBUFFERED` / `PYTHONIOENCODING` / `JAVA_TOOL_OPTIONS` 之类）
 * **不受名单限制**：它不是继承来的，是我们主动注入的，谈不上泄露。
 * 它也**覆盖** base 里的同名项 —— runner 比用户环境更知道这次要怎么跑
 * （比如强制 UTF-8 输出，那是流式解码能少走 OEM 路径的前提）。
 */
export function runEnv(
  base: NodeJS.ProcessEnv,
  declared: Record<string, string>,
  opts: RunEnvOptions = {},
): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform
  const win = platform === 'win32'
  const names = new Set<string>([
    ...COMMON_PASSTHROUGH, ...SEMANTIC,
    ...(win ? WIN_PASSTHROUGH : POSIX_PASSTHROUGH),
  ].map((n) => (win ? n.toUpperCase() : n)))
  const stripped = new Set<string>(STRIPPED.map((n) => (win ? n.toUpperCase() : n)))

  const out: NodeJS.ProcessEnv = {}
  // **遍历 base 的真实键**，而不是遍历名单去 `base[NAME]` 取值。两个理由：
  // ① Windows 的变量名大小写不敏感，真实写法是 `SystemRoot` / `ComSpec`；按名单的
  //    大写形式建键会把它改名，而**保留原始大小写**才不会给子进程塞进两份同名变量。
  // ② 前缀规则（npm_config_*）本来就只能靠遍历实际键来匹配。
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue          // 别给子进程塞一个空壳变量
    const probe = win ? key.toUpperCase() : key
    if (stripped.has(probe)) continue
    if (!names.has(probe) && !PREFIXES.some((p) => probe.startsWith(win ? p.toUpperCase() : p))) continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(declared)) out[key] = value
  return out
}
