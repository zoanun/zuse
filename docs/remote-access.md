# 远程访问 zuse（手机 / 平板 / 外网）

zuse 默认只监听 `127.0.0.1:4180` —— 本机可用、外部连不上。想从别的设备访问，**先解决加密**：
明文 HTTP 之下，登录口令与全部对话内容在同网段可被嗅探。

下面两条路径任选其一。**推荐隧道**，省证书、体验最好。

---

## 路径一：隧道（推荐）

隧道在前面终止 TLS，daemon 仍然只听回环 —— 回环上的明文不构成暴露面。

### tailscale（最省事）

```bash
# 1. daemon 照常跑（保持默认 127.0.0.1 绑定），加 --trust-proxy
zuse-server --trust-proxy

# 2. 另开一个终端，把 4180 挂到 tailnet 上
tailscale serve --bg 4180
```

然后在任何登了同一个 tailnet 的设备上打开 `https://<机器名>.<tailnet>.ts.net`。

好处：**真证书**（tailscale 自动签发，浏览器无警告）、无需端口转发、无需公网 IP，
并且 tailnet 本身就是一层设备级鉴权 —— 它与 zuse 的登录口令是**叠加**关系，不是替代。

### Cloudflare Tunnel

```bash
zuse-server --trust-proxy
cloudflared tunnel --url http://127.0.0.1:4180
```

cloudflared 会打印一个 `https://<随机名>.trycloudflare.com` 地址。适合临时分享；
长期使用建议配具名隧道 + 你自己的域名。

> ⚠️ **`--trust-proxy` 只在真有前置隧道时才开。** 它让 daemon 采信 `X-Forwarded-Proto`
> 请求头；这个头任何客户端都能伪造，裸奔在公网上开它等于让访问者自称"我是 https"。

---

## 路径二：直连 TLS（自带证书）

不依赖任何外部服务，纯内网可用。你需要**自备一对受信证书**：

### 用 mkcert（局域网场景最佳）

```bash
mkcert -install                 # 装一次本地 CA（各设备需信任它）
mkcert 192.168.1.23 localhost   # 换成你这台机器的局域网 IP / 主机名
zuse-server --host 0.0.0.0 --tls-cert ./192.168.1.23+1.pem --tls-key ./192.168.1.23+1-key.pem
```

### 用 tailscale 签的真证书

```bash
tailscale cert <机器名>.<tailnet>.ts.net
zuse-server --host 0.0.0.0 \
  --tls-cert <机器名>.<tailnet>.ts.net.crt \
  --tls-key  <机器名>.<tailnet>.ts.net.key
```

启用后 WebSocket 自动走 `wss://`（与页面同一个端口，无需额外配置）。

> `--tls-cert` 与 `--tls-key` **必须成对**给。只给一个、或文件路径不存在，daemon 会
> 直接报错退出 —— 安全配置不做静默降级，避免"以为在跑 https、其实是明文"。

---

## 为什么 zuse 不帮你生成自签证书

技术上很容易做，但体验会很差，所以有意不做：

1. **WSS 对未受信证书直接握手失败。** 页面还能点"继续前往"，WebSocket 不能 ——
   结果是"页面打开了、聊天连不上"的半死状态，比连不上更难排查。
2. **移动端要手动安装并信任证书**，iOS 尤其麻烦（要进设置里两处开关）。
3. `mkcert` 与 `tailscale cert` 给出的都是**受信**证书，上面两个问题都不存在。

把证书获取交给这两个成熟工具，zuse 只负责加载。

---

## 安全清单

- 绑 `0.0.0.0` 之前，确认这台机器的防火墙只对你信任的网段开放 4180。
- 走隧道时**不要**同时绑 `0.0.0.0` —— 保持 `127.0.0.1`，让隧道成为唯一入口。
- `--trust-proxy` 只在有前置隧道时开。
- 首次使用先设口令：`zuse-server --set-password`。
- 会话 cookie 的 `Secure` 属性会随实际传输自动开启（直连 TLS，或 `--trust-proxy` 且
  前置报告 https），本地明文开发则不加 —— 无需你手动配置。

## 顺带的好处

一旦走上 https，浏览器把页面视为 **secure context**，`crypto.randomUUID` 等 Web API 恢复
可用（zuse 在非 secure context 下有兜底实现，走 https 后不再触发）。
