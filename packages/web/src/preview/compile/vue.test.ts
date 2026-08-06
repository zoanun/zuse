import { describe, it, expect } from 'vitest'
import { compileVue } from './vue.js'
import { compile } from './index.js'

const SFC_SETUP_SCOPED = `
<template><b class="t">{{ msg }}</b></template>
<script setup>
import { ref } from 'vue'
const msg = ref('hi')
</script>
<style scoped>.t { color: red }</style>
`

describe('compileVue —— <script setup>', () => {
  it('产出可挂载的模块：导入 vue、命名为 __sfc__、挂到 #app', async () => {
    const r = await compileVue(SFC_SETUP_SCOPED)
    expect(r.errors).toEqual([])
    expect(r.js).toContain("from 'vue'")
    expect(r.js).toContain('__sfc__')
    expect(r.js).toContain("mount('#app')")
  })

  /**
   * 最难查的一个坑：`compileScript(inlineTemplate:true)` 在有 <script setup> 时**已经**
   * 把 render 内联进去了。若再单独 compileTemplate 拼一次，会得到双 render 的破组件 ——
   * 有时渲染两遍、有时白屏，且不报错。
   */
  it('有 <script setup> 时不得二次编译模板（不能出现独立的 render 赋值）', async () => {
    const r = await compileVue(SFC_SETUP_SCOPED)
    expect(r.js).not.toContain('__sfc__.render = render')
  })

  /**
   * 第二个「零报错静默失效」的坑：__scopeId 与 compileStyleAsync 的 id 必须**同值**。
   * 不同 → 样式注入了、属性选择器一个都匹配不上、页面看起来就是"样式没生效"。
   */
  it('scoped 样式的 scopeId 与样式产物同值', async () => {
    const r = await compileVue(SFC_SETUP_SCOPED)
    const m = r.js.match(/__scopeId\s*=\s*"(data-v-[a-z0-9]+)"/)
    expect(m).toBeTruthy()
    const scopeId = m![1]!
    expect(r.styles).toHaveLength(1)
    expect(r.styles[0]!.scopeId).toBe(scopeId)
    // 样式正文里也必须带上同一个属性选择器，否则说明 scoped 根本没生效。
    expect(r.styles[0]!.code).toContain(`[${scopeId}]`)
  })

  it('同一份代码两次编译得到同一个 scopeId（id 必须稳定，否则每次预览样式都换选择器）', async () => {
    const a = await compileVue(SFC_SETUP_SCOPED)
    const b = await compileVue(SFC_SETUP_SCOPED)
    expect(a.styles[0]!.scopeId).toBe(b.styles[0]!.scopeId)
  })

  it('无 scoped 样式时不注入 scopeId', async () => {
    const r = await compileVue(`<template><b/></template>\n<style>b{color:red}</style>`)
    expect(r.errors).toEqual([])
    expect(r.js).not.toContain('__scopeId')
    expect(r.styles[0]!.scopeId).toBeUndefined()
  })
})

describe('compileVue —— 传统 <script>（非 setup）', () => {
  it('这种形态才需要单独编译模板并挂 render', async () => {
    const r = await compileVue(`<template><i>{{ n }}</i></template>\n<script>export default { data: () => ({ n: 1 }) }</script>`)
    expect(r.errors).toEqual([])
    expect(r.js).toContain('__sfc__.render = render')
  })
})

describe('compileVue —— TypeScript', () => {
  it('剥掉类型（compiler-sfc 自己不做这件事）', async () => {
    const r = await compileVue(`
<template><b>{{ n }}</b></template>
<script setup lang="ts">
const n: number = 1
interface Unused { a: string }
</script>`)
    expect(r.errors).toEqual([])
    expect(r.js).not.toContain('interface Unused')
    expect(r.js).not.toContain(': number')
  })
})

describe('compileVue —— 浏览器里做不到的形态要给可读原因，而不是让它在 guest 里炸', () => {
  it('拒绝 <style module>', async () => {
    const r = await compileVue(`<template><b/></template>\n<style module>.a{color:red}</style>`)
    expect(r.errors.join()).toContain('CSS Modules')
    expect(r.js).toBe('')
  })

  it('拒绝 <style lang="scss">', async () => {
    const r = await compileVue(`<template><b/></template>\n<style lang="scss">.a{.b{color:red}}</style>`)
    expect(r.errors.join()).toContain('scss')
    expect(r.errors.join()).toContain('预处理器')
  })

  it('拒绝 <template lang="pug">', async () => {
    const r = await compileVue(`<template lang="pug">b Hello</template>\n<script setup></script>`)
    expect(r.errors.join()).toContain('pug')
  })

  it('模板语法错给出可读错误而不是抛穿', async () => {
    const r = await compileVue(`<template><b v-if></template>`)
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.js).toBe('')
  })
})

describe('compile 派发', () => {
  it('kind=vue 走 Vue 管线并真的产出代码（PR1 时这里是「尚未接入」）', async () => {
    const r = await compile({ kind: 'vue', code: SFC_SETUP_SCOPED })
    expect(r.errors).toEqual([])
    expect(r.js).toContain("mount('#app')")
  })

  it('Vue 产物里的未知裸包名同样被拦下', async () => {
    const r = await compile({ kind: 'vue', code: `<template><b/></template>\n<script setup>import x from 'lodash'</script>` })
    expect(r.errors.join()).toContain('lodash')
  })
})
