import { setGlobalDispatcher, ProxyAgent } from 'undici'
import type { ResolvedSettings } from './types.js'

/**
 * 若配置了代理，安装 undici 的全局 dispatcher。
 *
 * 之所以走「全局 dispatcher」而非给每处 fetch 传 dispatcher：Node 自带的 fetch（undici）
 * 既不读 Windows 系统代理、也不读 HTTP_PROXY 环境变量，但它会读 undici 的全局 dispatcher。
 * 装上后，所有经 globalThis.fetch 的出站请求都自动走代理 —— 包括大模型 API
 *（@anthropic-ai/sdk、openai 两个 SDK 默认用 globalThis.fetch）、WebFetch、WebSearch。
 * 一处安装，全部生效，无需把代理对象层层透传到各调用点。
 *
 * 代理地址来源见 mergeLayers：settings.proxy 字面量，或 ZUSE_PROXY 环境变量覆盖。
 * 未配置则什么都不做（直连）。返回实际生效的代理地址（无则 undefined），便于启动日志与测试断言。
 *
 * @param setDispatcher 默认 undici 的 setGlobalDispatcher；仅测试时注入假实现，避免真的改全局。
 */
export function installProxy(
  settings: ResolvedSettings,
  setDispatcher: (dispatcher: ProxyAgent) => void = setGlobalDispatcher,
): string | undefined {
  const url = settings.proxy?.trim()
  if (!url) return undefined
  // 提前校验地址：ProxyAgent 对畸形地址（如漏写 http:// 的 "localhost:8080"）不会在构造时
  // 报错，而是拖到首个请求才隐性失败。这里把它变成构造前的清晰异常，由调用方决定如何告警。
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`无效的代理地址：${url}（需形如 http://host:port）`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`代理地址协议无效：${url}（仅支持 http / https，如 http://host:port）`)
  }
  setDispatcher(new ProxyAgent(url))
  return url
}
