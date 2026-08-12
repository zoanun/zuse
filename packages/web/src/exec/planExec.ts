/**
 * 代码块 → 可执行的东西（spec §2）。
 *
 * **纯函数**：不碰文件系统、不起进程、不知道自己会被写到哪个目录。
 * 返回的是**相对文件名**，目录由服务端决定（浏览器写不了服务端磁盘，
 * 目录也只有服务端知道 —— v1 把落盘推给"调用方"是个架构空洞）。
 */

export type ExecKind = 'python' | 'java'

export interface ExecPlan {
  /** 交给 run 服务的那条命令。`<dir>` 由服务端替换成真实临时目录。 */
  command: string
  /** 需要落盘的文件，**相对文件名，不含目录**。 */
  files: { name: string; content: string }[]
  /** 展示用的一句话。 */
  label: string
  /** 静态就能看出来的问题；只提示、不阻断。 */
  hint?: string
}

/** 服务端把它替换成真实的临时目录。放在这里是为了两端共用同一个约定。 */
export const EXEC_DIR_PLACEHOLDER = '<dir>'

export function planExec(kind: ExecKind, code: string): ExecPlan {
  if (kind === 'python') {
    return {
      // `--no-project` 是实测定的（spec §0.2），不是风格选择：不带它，uv 会在
      // **用户的仓库里**建 .venv + uv.lock 并装包；用户项目里一个解析不了的
      // pyproject 还会让脚本压根跑不起来（× No solution found）。
      command: `uv run --no-project "${EXEC_DIR_PLACEHOLDER}/main.py"`,
      files: [{ name: 'main.py', content: code }],
      label: '用 uv 跑 Python',
    }
  }
  // 三个 -D 都给：stdout/stderr 是实测有效的那两个（管道下 Java 默认吐 OEM 字节）；
  // file.encoding 在 JDK 18+ 是空操作，留着只为兼容更老的 JDK（该兼容性未实测）。
  // **stderr 那个不能省** —— Java 片段最常见的用户可见输出是编译错误，走 stderr。
  const flags = '-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8'
  return {
    // 文件名恒为 Main.java。**单文件源码模式不校验文件名**（实测：`public class Hello`
    // 存成 Main.java 照跑 exit=0），所以不去解析类名 —— 那是基于错误前提的多余复杂度。
    command: `java ${flags} "${EXEC_DIR_PLACEHOLDER}/Main.java"`,
    files: [{ name: 'Main.java', content: code }],
    label: '用 java 单文件模式跑',
    ...(javaHint(code) ? { hint: javaHint(code)! } : {}),
  }
}

/**
 * 实测会失败的两种形态（spec §0.3b），提前说一声。
 *
 * **只提示、不阻断**：这是个启发式扫描，拦下去就是又一个假防护
 * （同 §5 安全闸那条教训 —— 挡不住真问题却误伤正常代码）。
 */
function javaHint(code: string): string | undefined {
  // 去掉注释与字符串再看结构，否则注释里的 "class" 会骗过它。
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')

  const firstType = /\b(?:class|interface|enum|record)\s+(\w+)/.exec(stripped)
  if (!firstType) return '这段 Java 看起来跑不起来：单文件模式要求代码在一个类里，不能是裸语句。'

  // 第一个顶层类必须带 main —— 实测报「在类 Helper 中找不到 main(String[]) 方法」。
  // 判据：从第一个类型声明开始，到**下一个**类型声明之前，这段里有没有 main。
  const start = firstType.index
  const next = /\b(?:class|interface|enum|record)\s+\w+/g
  next.lastIndex = start + firstType[0].length
  const m = next.exec(stripped)
  const firstBody = stripped.slice(start, m ? m.index : undefined)
  if (!/\bstatic\s+void\s+main\s*\(/.test(firstBody)) {
    return `这段 Java 看起来跑不起来：单文件模式要求**第一个**类（这里是 ${firstType[1]}）里有 main 方法。`
  }
  return undefined
}
