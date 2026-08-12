import { describe, expect, it } from 'vitest'
import { planExec } from './planExec.js'

describe('planExec —— Python', () => {
  it('落一个 main.py，用 uv run --no-project 跑', () => {
    const p = planExec('python', 'print("hi")')
    expect(p.files).toEqual([{ name: 'main.py', content: 'print("hi")' }])
    expect(p.command).toContain('uv run --no-project')
    expect(p.command).toContain('main.py')
  })

  /**
   * `--no-project` 不是可有可无的开关，是实测定下来的（spec §0.2）：
   * 不带它，`uv` 会在**用户的仓库里**建 `.venv` + `uv.lock` 并装包；
   * 用户项目里一个解析不了的 pyproject 还会让脚本压根跑不起来。
   */
  it('必须带 --no-project（否则会在用户仓库里建 .venv）', () => {
    expect(planExec('python', 'x').command).toMatch(/uv run --no-project/)
  })
})

describe('planExec —— Java', () => {
  it('落一个 Main.java，三个编码开关都要给', () => {
    const p = planExec('java', 'public class Main { public static void main(String[] a){} }')
    expect(p.files[0]!.name).toBe('Main.java')
    // stdout/stderr 是实测有效的那两个；file.encoding 成本为零、用于兼容 JDK 19 以下。
    // **stderr 那个不能漏**：Java 片段最常见的用户可见输出就是编译错误，走的是 stderr。
    expect(p.command).toContain('-Dstdout.encoding=UTF-8')
    expect(p.command).toContain('-Dstderr.encoding=UTF-8')
    expect(p.command).toContain('-Dfile.encoding=UTF-8')
  })

  /**
   * **文件名不需要匹配 public class**（实测：`public class Hello` 存成 `Main.java`
   * 照跑，exit=0）。spec v1 曾断言要解析类名，那是凭 javac 常识推断、没实测。
   */
  it('文件名恒为 Main.java，不去解析 public class 名', () => {
    expect(planExec('java', 'public class Hello {}').files[0]!.name).toBe('Main.java')
  })

  /** 以下两条才是实测会失败的形态（spec §0.3b），给提示但**不阻断**。 */
  it('裸语句：给提示（单文件模式要求有类）', () => {
    const p = planExec('java', 'System.out.println("hi");')
    expect(p.hint).toBeTruthy()
    expect(p.hint).toContain('类')
  })

  it('第一个顶层类没有 main：给提示', () => {
    const p = planExec('java', 'class Helper { static int f(){return 1;} }\npublic class Main { public static void main(String[] a){} }')
    expect(p.hint).toBeTruthy()
    expect(p.hint).toContain('main')
  })

  it('正常的 Java 不给提示（提示只在真有问题时出现，否则就是噪音）', () => {
    expect(planExec('java', 'public class Main { public static void main(String[] a){ System.out.println(1); } }').hint).toBeUndefined()
    // 第一个类就带 main，且前面有 import —— 常见形态，不该误报
    expect(planExec('java', 'import java.util.*;\npublic class Main { public static void main(String[] a){} }').hint).toBeUndefined()
  })
})
