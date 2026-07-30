import { generate } from 'selfsigned'

/** 一对 PEM。 */
interface Pems { cert: string; key: string }

let cached: Promise<Pems> | undefined

/**
 * 生成一对测试用自签证书(CN=localhost)。每个测试进程只真正生成一次。
 *
 * 为什么不内联成常量:那样仓库里就常驻一整块 PEM 私钥,而 zuse 是**公开仓** —— 实质无害
 * (一次性的 localhost 自签钥,且 tsup 只打包 index/bin,它进不了 dist),但会持续触发
 * secret scanning 与人工审计的告警。`selfsigned` 是 **devDependency**,不随发布产物走,
 * 同时也不要求系统装了 openssl。
 *
 * 缓存的是 **promise** 而非结果,并发调用才不会各自触发一次密钥生成。省下的其实不多
 * (实测 RSA-2048 生成 13~42ms,本文件三处调用共省 ~70ms);真正的大头是 `selfsigned` 的
 * 导入本身(冷启 ~195ms,拉进 @peculiar/x509 + pkijs),那部分缓存回避不掉 —— 但相对整个
 * server 套件(~39s)可以忽略,为「公开仓里不放私钥」付这个价是值的。
 */
export function makeTestCerts(): Promise<Pems> {
  // selfsigned 缺省签名算法是 sha1,OpenSSL 3 在默认 security level 下会拒 —— 必须显式 sha256。
  // 有效期给 1 天:测试用完即弃,没有理由签一张长期证书。
  cached ??= generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).then((pems) => ({ cert: pems.cert, key: pems.private }))
  return cached
}
