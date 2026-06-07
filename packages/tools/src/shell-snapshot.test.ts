import { describe, it, expect } from 'vitest'
import { snapshotBuilderScript } from './shell-snapshot.js'

const BASH_OPTS = { label: 'bash', snapshotFile: '/home/u/.zuse/s.sh', configFile: '/home/u/.bashrc', configFileExists: true }
const ZSH_OPTS = { label: 'zsh', snapshotFile: '/home/u/.zuse/s.sh', configFile: '/home/u/.zshrc', configFileExists: true }

describe('snapshotBuilderScript — 通用结构', () => {
  it('显式 source rc、设 SNAPSHOT_FILE、并把 PATH 用 %q 写入', () => {
    const s = snapshotBuilderScript(BASH_OPTS)
    expect(s).toContain(`SNAPSHOT_FILE='/home/u/.zuse/s.sh'`)
    expect(s).toContain(`source '/home/u/.bashrc'`)
    expect(s).toContain("printf 'export PATH=%q")
  })

  it('rc 不存在时不 source,仍生成脚本(只捕获登录环境)', () => {
    const s = snapshotBuilderScript({ ...BASH_OPTS, configFileExists: false })
    expect(s).not.toContain("source '")
    expect(s).toContain("printf 'export PATH=%q")
  })

  // 顺序铁律:unalias -a 在函数之前(定义函数时无别名,规避碰撞),别名在函数之后。
  it('unalias -a 在最前,别名在函数之后', () => {
    for (const opts of [BASH_OPTS, ZSH_OPTS]) {
      const s = snapshotBuilderScript(opts)
      expect(s).toContain('unalias -a')
      // 别名转储块(alias -- )必须出现在 PATH 之前、函数之后。
      expect(s).toContain('alias -- ')
      expect(s.indexOf('unalias -a')).toBeLessThan(s.indexOf('# 函数'))
      expect(s.indexOf('# 函数')).toBeLessThan(s.indexOf('alias -- '))
    }
  })

  // Windows git-bash 的 winpty 别名在脚本内过滤(改 CC 的 Node 端过滤为脚本内分支)。
  it('含 winpty 别名过滤分支', () => {
    expect(snapshotBuilderScript(BASH_OPTS)).toContain(`grep -v "='winpty "`)
  })
})

describe('snapshotBuilderScript — bash', () => {
  it('shopt -p 在函数转储之前(extglob 须先就位,否则含 extglob 的函数体解析报错)', () => {
    const s = snapshotBuilderScript(BASH_OPTS)
    expect(s).toContain('shopt -p')
    expect(s).toContain('expand_aliases')
    expect(s.indexOf('shopt -p')).toBeLessThan(s.indexOf('declare -F'))
  })

  it('滤掉单下划线补全函数,用内建 declare -f 逐个转储(无 base64,避免 Windows 逐函数 spawn)', () => {
    const s = snapshotBuilderScript(BASH_OPTS)
    expect(s).toContain(`grep -vE '^_[^_]'`)
    expect(s).toContain('declare -f "$func"')
    expect(s).not.toContain('base64')
  })

  // 不照搬 set -o:errexit/pipefail 等会破坏 source;命令;exit $? 的包装。
  it('不导出 set -o 行为开关', () => {
    expect(snapshotBuilderScript(BASH_OPTS)).not.toContain('set -o ')
  })
})

describe('snapshotBuilderScript — zsh', () => {
  it('用 typeset 转储函数(非 declare -f/base64),并过滤补全函数', () => {
    const s = snapshotBuilderScript(ZSH_OPTS)
    expect(s).toContain('typeset +f')
    expect(s).toContain('typeset -f')
    expect(s).toContain(`grep -vE '^_[^_]'`)
    expect(s).not.toContain('declare -F')
    expect(s).not.toContain('base64')
  })

  it('只恢复 glob 相关 setopt,不照搬全部', () => {
    const s = snapshotBuilderScript(ZSH_OPTS)
    expect(s).toContain('extendedglob')
    // 旧实现的 unsetopt/setopt aliases 夹函数的 hack 已被 unalias -a 取代,不应再出现。
    expect(s).not.toContain('unsetopt aliases')
  })
})
