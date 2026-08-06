import type { CompileResult, PreviewStyle } from '../types.js'

/**
 * 稳定 id：scoped 样式的 `data-v-xxx` 属性由它派生。
 *
 * **必须单点生成、两处共用**：`__sfc__.__scopeId` 与 `compileStyleAsync({ id })` 用的
 * 若不是同一个值，样式会被注入、但属性选择器一个都匹配不上 —— **零报错，样式静默失效**。
 * 这是本文件最容易写错、也最难查的一处。
 */
function stableId(code: string): string {
  let h = 5381
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) >>> 0
  return h.toString(36).padStart(7, '0').slice(0, 8)
}

/** 浏览器里没有预处理器；这些 lang 直接拒绝，给可读提示而不是让它在 guest 里炸得莫名其妙。 */
const UNSUPPORTED_STYLE_LANGS = ['scss', 'sass', 'less', 'stylus', 'styl']
const UNSUPPORTED_TEMPLATE_LANGS = ['pug', 'jade', 'haml']

export async function compileVue(code: string): Promise<CompileResult> {
  const [sfc, sucrase] = await Promise.all([import('vue/compiler-sfc'), import('sucrase')])
  const id = stableId(code)
  const errors: string[] = []

  const { descriptor, errors: parseErrors } = sfc.parse(code, { filename: 'Preview.vue' })
  if (parseErrors.length > 0) {
    return { js: '', styles: [], errors: parseErrors.map((e) => `SFC 解析失败：${e.message}`) }
  }

  // 先把浏览器里做不到的形态挡掉，给出可读原因。
  for (const s of descriptor.styles) {
    if (s.module) errors.push('预览不支持 <style module>（CSS Modules）')
    const lang = s.lang?.toLowerCase()
    if (lang && UNSUPPORTED_STYLE_LANGS.includes(lang)) errors.push(`预览不支持 <style lang="${lang}">：浏览器里没有预处理器`)
  }
  const tplLang = descriptor.template?.lang?.toLowerCase()
  if (tplLang && UNSUPPORTED_TEMPLATE_LANGS.includes(tplLang)) {
    errors.push(`预览不支持 <template lang="${tplLang}">：浏览器里没有预处理器`)
  }
  if (errors.length > 0) return { js: '', styles: [], errors }

  const hasScoped = descriptor.styles.some((s) => s.scoped)
  const isTs = /^(ts|typescript)$/i.test(descriptor.script?.lang ?? descriptor.scriptSetup?.lang ?? '')

  let script: string
  // 纯展示组件（只有 <template>，没有任何 <script>）是合法且常见的写法，但
  // compileScript 会直接抛 "SFC contains no <script> tags"。此时自己造一个空组件对象，
  // 模板走下面的 compileTemplate 分支挂上去。
  if (!descriptor.script && !descriptor.scriptSetup) {
    script = 'const __sfc__ = {}'
  } else {
  try {
    const compiled = sfc.compileScript(descriptor, {
      id,
      inlineTemplate: true,
      // 直接把默认导出命名为 __sfc__，省得去正则改写 `export default`（那种改写遇到
      // 字符串里含 "export default" 就会出错）。
      genDefaultAs: '__sfc__',
      templateOptions: { compilerOptions: { scopeId: hasScoped ? `data-v-${id}` : undefined } },
    })
      script = compiled.content
    } catch (e) {
      return { js: '', styles: [], errors: [`编译失败：${e instanceof Error ? e.message : String(e)}`] }
    }
  }

  // **只有在没有 <script setup> 时才单独编译模板。**
  // compileScript(inlineTemplate:true) 在有 <script setup> 时已经把 render 内联进去了；
  // 再拼一次会得到双 render 的破组件 —— 症状诡异（有时渲染两遍、有时白屏）。
  if (descriptor.template && !descriptor.scriptSetup) {
    try {
      const tpl = sfc.compileTemplate({
        source: descriptor.template.content,
        filename: 'Preview.vue',
        id,
        scoped: hasScoped,
        compilerOptions: { scopeId: hasScoped ? `data-v-${id}` : undefined },
      })
      if (tpl.errors.length > 0) {
        return { js: '', styles: [], errors: tpl.errors.map((e) => `模板编译失败：${typeof e === 'string' ? e : e.message}`) }
      }
      script += `\n${tpl.code}\n__sfc__.render = render`
    } catch (e) {
      return { js: '', styles: [], errors: [`模板编译失败：${e instanceof Error ? e.message : String(e)}`] }
    }
  }

  const styles: PreviewStyle[] = []
  for (const s of descriptor.styles) {
    try {
      const out = await sfc.compileStyleAsync({
        source: s.content,
        filename: 'Preview.vue',
        // 与上面 __scopeId 同源同值 —— 见 stableId 的注释。
        id: `data-v-${id}`,
        scoped: s.scoped,
      })
      // 浏览器版 compiler-sfc 内联了 postcss，它会调 pathToFileURL —— 浏览器里没有这个。
      // 上游 REPL 同样显式忽略这类错误：样式本身已经产出，报的是 source-map 相关的边角。
      const real = out.errors.filter((e) => !/pathToFileURL|not.*polyfill/i.test(String(e)))
      if (real.length > 0) errors.push(...real.map((e) => `样式编译失败：${String(e)}`))
      styles.push({ code: out.code, scopeId: s.scoped ? `data-v-${id}` : undefined })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/pathToFileURL/i.test(msg)) errors.push(`样式编译失败：${msg}`)
    }
  }

  // compiler-sfc 自己不剥 TypeScript，要额外过一道（上游 REPL 用的也是 sucrase）。
  if (isTs) {
    try {
      script = sucrase.transform(script, { transforms: ['typescript'] }).code
    } catch (e) {
      return { js: '', styles: [], errors: [`TypeScript 转换失败：${e instanceof Error ? e.message : String(e)}`] }
    }
  }

  const js = [
    `import { createApp as __createApp } from 'vue'`,
    script,
    hasScoped ? `__sfc__.__scopeId = ${JSON.stringify(`data-v-${id}`)}` : '',
    `__createApp(__sfc__).mount('#app')`,
  ].filter(Boolean).join('\n')

  return { js, styles, errors }
}
