import { describe, it, expect } from 'vitest'
import { compile } from './index.js'
import { scanBareImports, transformScript } from './script.js'

describe('transformScript —— JSX runtime 必须是 automatic+production', () => {
  // 这条是本文件最重要的锁。选错 runtime 不会报错，只会让**所有 JSX 预览**在 guest 里
  // 挂掉，而且症状各不相同（classic → React is not defined；automatic → 模块解析失败）。
  it('JSX 走 react/jsx-runtime，不是 jsx-dev-runtime，也不是 React.createElement', async () => {
    const out = await transformScript('const A = () => <div>hi</div>', 'jsx')
    expect(out).toContain('react/jsx-runtime')
    expect(out).not.toContain('jsx-dev-runtime')
    expect(out).not.toContain('React.createElement')
  })

  // production:true 顺带去掉了 __self/__source 注入 —— 那些在 guest 里是纯噪音。
  it('不注入 __self / __source 调试字段', async () => {
    const out = await transformScript('const A = () => <div>hi</div>', 'tsx')
    expect(out).not.toContain('__self')
    expect(out).not.toContain('__source')
  })

  it('TSX 同时剥类型与转 JSX', async () => {
    const out = await transformScript('const A = (p: {x: number}) => <b>{p.x}</b>', 'tsx')
    expect(out).not.toContain(': {x: number}')
    expect(out).toContain('react/jsx-runtime')
  })

  it('纯 TS 只剥类型，不引 jsx runtime', async () => {
    const out = await transformScript('const x: number = 1', 'ts')
    expect(out).toContain('const x = 1')
    expect(out).not.toContain('jsx-runtime')
  })

  it('js / html 原样返回，不过编译器', async () => {
    expect(await transformScript('const x=1', 'js')).toBe('const x=1')
    expect(await transformScript('<p>x</p>', 'html')).toBe('<p>x</p>')
  })
})

describe('scanBareImports', () => {
  it('认出裸包名，忽略相对路径与 URL', () => {
    const code = [
      `import React from 'react'`,
      `import { x } from "./local.js"`,
      `import y from '/abs.js'`,
      `import z from 'https://cdn.example/m.js'`,
      `import { render } from 'react-dom/client'`,
      `export { a } from 'lodash-es'`,
    ].join('\n')
    expect(scanBareImports(code).sort()).toEqual(['lodash-es', 'react', 'react-dom/client'])
  })

  it('副作用 import 也算', () => {
    expect(scanBareImports(`import 'some-polyfill'`)).toEqual(['some-polyfill'])
  })
})

describe('compile', () => {
  it('未知包给出可读提示，而不是让浏览器抛晦涩的模块解析错', async () => {
    const r = await compile({ kind: 'jsx', code: `import _ from 'lodash'\nconst A=()=><i/>` })
    expect(r.errors.join()).toContain('lodash')
    expect(r.errors.join()).toContain('预览环境里没有')
  })

  it('用表内的包不报错', async () => {
    const r = await compile({ kind: 'tsx', code: `import { useState } from 'react'\nconst A=()=><i/>` })
    expect(r.errors).toEqual([])
    expect(r.js).toContain('react/jsx-runtime')
  })

  it('语法真错时给出编译失败而不是抛穿', async () => {
    const r = await compile({ kind: 'tsx', code: 'const A = () => <div>' })
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.errors[0]).toContain('编译失败')
  })

  // PR1 不支持 Vue。必须显式报未支持 —— 若掉进 transformScript 当普通 JS 处理，
  // 会静默产出一段跑不起来的东西，用户只看到白屏。
  it('vue 在 PR1 明确报未接入，不静默产出坏东西', async () => {
    const r = await compile({ kind: 'vue', code: '<template><b/></template>' })
    expect(r.js).toBe('')
    expect(r.errors.join()).toContain('尚未接入')
  })

  it('html 不进编译器', async () => {
    const r = await compile({ kind: 'html', code: '<!doctype html><p>x</p>' })
    expect(r).toEqual({ js: '', styles: [], errors: [] })
  })
})
