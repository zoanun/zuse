/** 服务器就绪策略 —— 何时认为「可以开始查了」。 */
export type ReadyStrategy = 'immediate' | 'awaitProgress' | 'awaitNotification'

/** 单门语言的服务器配置。加语言 = 加一条。 */
export interface LanguageServerConfig {
  id: string
  extensions: string[]
  command: string
  args: string[]
  initializationOptions?: unknown
  ready: ReadyStrategy
  readyNotification?: string
  dataDirArg?: (tmpDir: string) => string[]
  installHint: string
  /**
   * 可被 LspInstall 自动执行的安装命令(argv 形式)。仅给「能用一条干净命令装好」的语言填——
   * v1 只填 npm 系(npm 几乎必然在,不假定 rustup/go/JDK 等其它工具链)。
   * 未填的语言(java/lua/rust/go)LspInstall 一律婉拒,只回显 installHint 让用户手动装,
   * 绝不递归去装 JDK/Maven 这类系统级前置依赖。
   */
  installCommand?: string[]
}

/** v1 预置 8 门语言。加一门 = 往这个数组加一条,无需改其它代码。 */
export const LANGUAGE_SERVERS: LanguageServerConfig[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    ready: 'immediate',
    installHint: 'npm i -g typescript-language-server typescript',
    installCommand: ['npm', 'i', '-g', 'typescript-language-server', 'typescript'],
  },
  {
    id: 'python',
    extensions: ['.py', '.pyi'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    ready: 'immediate',
    installHint: 'npm i -g pyright',
    installCommand: ['npm', 'i', '-g', 'pyright'],
  },
  {
    id: 'vue',
    extensions: ['.vue'],
    command: 'vue-language-server',
    args: ['--stdio'],
    ready: 'immediate',
    installHint: 'npm i -g @vue/language-server（Volar 需 initializationOptions.typescript.tsdk 指向本机 typescript lib 目录）',
    installCommand: ['npm', 'i', '-g', '@vue/language-server'],
  },
  {
    id: 'java',
    extensions: ['.java'],
    command: 'jdtls',
    args: [],
    ready: 'awaitNotification',
    readyNotification: 'language/status',
    dataDirArg: (tmpDir: string): string[] => ['-data', tmpDir],
    installHint: '安装 Eclipse JDT LS（提供 jdtls 启动脚本）；本机需有 JDK',
  },
  {
    id: 'rust',
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
    ready: 'awaitProgress',
    installHint: 'rustup component add rust-analyzer',
  },
  {
    id: 'go',
    extensions: ['.go'],
    command: 'gopls',
    args: [],
    ready: 'awaitProgress',
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'lua',
    extensions: ['.lua'],
    command: 'lua-language-server',
    args: [],
    ready: 'immediate',
    installHint: '安装 lua-language-server（scoop/brew/手动）',
  },
  {
    id: 'bash',
    extensions: ['.sh', '.bash'],
    command: 'bash-language-server',
    args: ['start'],
    ready: 'immediate',
    installHint: 'npm i -g bash-language-server',
    installCommand: ['npm', 'i', '-g', 'bash-language-server'],
  },
]

/** 按文件扩展名(小写)查语言配置;未命中返回 null。 */
export function lookupLanguage(filePath: string): LanguageServerConfig | null {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return null
  const ext = lower.slice(dot)
  return LANGUAGE_SERVERS.find((c) => c.extensions.includes(ext)) ?? null
}
