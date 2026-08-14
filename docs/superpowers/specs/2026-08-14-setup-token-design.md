# 暴露形态的一次性 setup token（回溯审计 D2 · 第 2 步）

> v2 —— 按独立评审的 12 条重写。改动最大的是 §2.1 判据、§2.3 的取回途径、§2.6 前端联动
> 和 §5 测试清单。v1 的三处**事实错误**在 §7 逐条列出，没有悄悄抹掉。

## 一、这一步要补的是哪半个洞

第 1 步（`476028d`）上了 Host / Origin 两把锁，堵的是**「用户访问了一个恶意网页」**这条链路。
那两把锁是**纯浏览器侧**的防御 —— 它们靠的是浏览器**如实**发送 `Host` / `Origin`。

`curl` 不受任何约束。所以下面这条链**完全没被第 1 步碰到**：

```
daemon 暴露在网上且尚未设口令
  → 局域网里另一台机器 / 隧道 URL 的任意访客
  → curl -X POST /api/auth/setup -d '{"password":"attacker"}'   ← 唯一的门是「是否已配置」
  → login（用他自己设的口令）
  → POST /api/runs 任意命令
```

**「先到先得」的口令设置，在一台联网的机器上等于把 RCE 挂在公网上。**

隧道形态尤其要命：`cloudflared tunnel --url http://127.0.0.1:4180` 打印的是一个**公网可达**
的随机域名 —— 它不是秘密，谁拿到谁能打。而 `docs/remote-access.md` 正在把这条路径当推荐做法。

## 二、方案

**暴露形态**启动时生成一次性 setup token；`POST /api/auth/setup` 要求带上它。

### 2.1 「暴露」的判据 —— 以及它**必然**漏掉什么

```
isExposedDeployment(cfg) =
     host 不是 127.0.0.1 / localhost / ::1          // 空串、0.0.0.0、::、LAN IP、域名 全部算暴露
  || trustProxy
  || allowedHosts 非空                              // 含裸 `*`
  || tlsCert !== undefined
```

后两条是评审加的，**理由是第 1 步留下的强信号**：第 1 步之后，任何「浏览器 + 域名」的远程
形态都**必须**给 `--allowed-host`，两条路都堵死 —— 代理透传隧道域名会被 Host 闸拒，
代理改写成回环则 `/api/*` 会被 Origin 闸拒。所以 `--allowed-host` 出现 ≈ 运维在声明「这台
机器要被远程访问」。`--tls-cert` 同理。代价实测为零：`ZUSE_ALLOWED_HOSTS` 未设时
`defaultConfig().allowedHosts` 是 `[]`，本仓 `/restart` 技能的启动命令不带任何相关参数。

**判据实现上的两个坑**（评审实测）：

- **`--host ""` 是可达的**：`parseArgs` 只要 `h !== undefined` 就设，而 `listen(0, '')`
  实测绑的是 `::`（全网卡）。所以判据必须写成**回环白名单**，绝不能「顺手优化」成
  `if (!cfg.host) return false` 之类的 falsy 短路。
- `--host 127.0.0.2`（多实例开发）会被判成暴露、要 token。**这是刻意的**：
  写成 `127.0.0.0/8` 前缀匹配是**放宽**，别改。

**残留漏报，必须诚实写出来（v1 那句「不可漏报」是错的）**：

| 形态 | 为什么漏 |
|---|---|
| **任何 daemon 观测不到的外部端口转发**，且一个相关参数都没加 —— `cloudflared`、`ssh -R`、`socat`、同机反代 | 判据只能看启动参数，看不见另一个进程。浏览器用不了（会被第 1 步的闸拒），但 **curl 伪造 `Host: 127.0.0.1:4180` 穿过隧道仍可达 setup** |
| 同机反代 + **用裸 IP 访问**（`http://203.0.113.5/` → nginx → 回环） | Host 是 IP 字面量 → Host 闸无条件放行；Origin 与 Host 逐字相等 → Origin 闸放行。既不需要 `--allowed-host` 也不需要 `--trust-proxy`，连浏览器都拦不住 |

**`--allowed-host *` 会同时触发 token，这不矛盾**：`*` 关掉的是 Host 白名单（rebinding 那把锁），
token 挡的是 curl 抢先 setup —— 两个不同的洞。把最强的一把锁关掉之后**更**需要另一把。
但**要处理 UX**：用户吃了 `host_not_allowed` 403 → 按提示加 `--allowed-host` 重启 →
立刻吃第二个 `setup_token_required` 403，很容易以为自己越配越错。
`docs/remote-access.md` 的配方要把两步**写在一起**。

这两条**没有可靠的自动判据** —— 「本机有没有隧道在跑」不是 daemon 能观测的事实。
处置：**文档兜底**。`docs/remote-access.md` 的每条配方都要带 `--allowed-host`
（第 1 步之后浏览器本来就必须加），启动横幅在「未配置口令 + 未判为暴露」时补一句
「若你把它放在任何隧道 / 反代后面，请加 `--allowed-host <域名>`」。
把它写成一条**已知缺口**，好过写一句「不会漏报」骗后来的人不再查。

### 2.2 回环形态**不要** token

默认 `127.0.0.1` 绑定：网络上根本连不到。**同一用户账户下**的恶意进程能连 ——
但它已经能直接读 `~/.zuse/web-auth.json`、直接跑任意命令，token 换不到任何安全性，
却会给「首次打开页面」加一步复制粘贴。

**安全摩擦要花在真的能挡住攻击的地方。**

> **限定语，别把这条论断说绝对了**（v1 说绝对了）：它只对**同一用户账户**成立。
> 共享主机上另一个非特权账户**连得到** `127.0.0.1:4180`，却**读不到**你家目录下
> 0600 的 `web-auth.json` —— 对它来说抢先 setup 是一条实打实的本地提权。
> 这条记在「已知缺口」里，行为不改（多账户开发机在本仓不是目标场景）。

### 2.3 token 本体与**两条取回途径**

- `randomBytes(24).toString('base64url')` → 32 字符、192 bit 熵（实测确认长度）。
- **两条取回途径，缺一条就有人被永久锁在门外**：
  1. 启动横幅（`console.warn`，与其他安全横幅一致，走 stderr）；
  2. **写 `<authDir>/setup-token`，`chmod 0600`**（`passwordStore.ts:33` 已有同样的写法）。

  第 2 条是评审提的：`nohup` / systemd / Windows 服务 / 后台启动**看不到 stderr**，
  而「找不回来就重启」在这些形态下是死循环 —— 重启只会换一个同样看不见的新 token，
  远程访问被永久封死。

  **0600 的实际效力，按平台照实说（第二轮评审实测推翻了 v2 的说法）**：

  | 平台 | 0600 有没有用 |
  |---|---|
  | POSIX | 有效。写入时就带 `mode`，别先建再 chmod —— 中间有 umask 窗口 |
  | **Windows（本仓主力平台）** | **是 no-op。** 实测 chmod 0600 后 `icacls` 仍是 `BUILTIN\Users:(I)(RX)`；node 只把 chmod 映射到只读属性，根本不碰 DACL。真正在保护默认 authDir 的是 `%USERPROFILE%\.zuse` **继承来的 ACL** |

  推论：**authDir 一旦被指到 ACL 更宽的位置（ProgramData / 共享盘 / CI workdir），
  这层保护为零。** v2 写的「那正是文件权限在保护的东西」在 Windows 上是假的。

### 2.3.1 文件生命周期（v2 漏写，漏出来一个真 bug）

| 时机 | 动作 |
|---|---|
| 暴露 + 未配置口令 | 写（覆盖），mode 0600 |
| **已配置口令** + 文件存在 | 删 |
| 其它（非暴露、或暴露但没文件） | **什么都不做** |

**第 2 行的条件必须是「已配置口令」，不能是「非暴露形态」。** v2 没写生命周期，
实现自己补了个「不是暴露形态就删」，评审实测复现出真 bug：同机两个 daemon 共用默认
`~/.zuse`，后起的本机那个会把先起的暴露那个**正在用的活 token 文件**删掉 ——
恰好打死落盘存在的唯一理由。

收紧到「已配置口令」之后是安全的：共用 authDir 的实例共用同一份 `web-auth.json`，
口令一旦设上，**所有**实例的 token 都不可能再被用到（见下一条）。
`close()` 不删 —— 进程活着期间文件就该在。

**「暴露 + 已配置口令」这个状态会产生一个谁也拿不到的 token**（生成了、传给 handler 了、
路由会要求它，但横幅不打、文件被删）。今天它不可达，**因为 setup 路由第一件事是
`isConfigured() → 409`，排在 token 校验之前**。这条隐含依赖必须写出来：
**改动 setup 路由的判断顺序时要一并复查这里。**
- **不设 TTL、不因失败次数失效。** 192 bit 爆破不现实；设 TTL 会打死
  「先起 daemon、隧道弄好半小时后才第一次打开页面」这个完全正常的流程。
- **无条件生成**（暴露形态下），即使启动时已经设过口令。
  **理由是「不让 token 的存在与否依赖一个会变的运行期状态」**，纯粹为了少一类时序 bug ——
  **不是** v1 写的那个「删口令文件会重开 setup 门」，那条已被实测证伪（见 §7）。
  横幅与文件**只在尚未配置口令时**产出（已配置时打出来是噪音）。

### 2.4 传输与校验

- 请求体字段 `setupToken`（与 `password` 并列）。
  **不用自定义头**：自定义头会触发 CORS 预检，而 Origin 闸已经在挡跨站，预检换不到额外安全。
  **不进 URL query**：会进浏览器历史、代理日志、`Referer`。
- **先判类型，再 `Buffer.from`。** `typeof setupToken !== 'string'` 一律按缺失处理；
  长度 > 256 直接判否。
  **这不是洁癖，是一条未鉴权的单线程 DoS**（评审实测）：
  ```
  $ node -e "const t0=Date.now();const b=Buffer.from({length:200000000});console.log(b.length,Date.now()-t0)"
  200000000 6578        ← 一个 35 字节的 JSON body，把主线程冻 6.6 秒
  ```
- 比较用 `timingSafeEqual`，**长度不等先短路**（实测长度不等会
  `throw ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` —— 是真实崩溃路径，不是理论风险）。
- 顺手给 `/api/auth/setup` 与 `/api/auth/login` 的 `readJsonBody` 加 8 KiB cap
  （该函数支持 `maxBytes`，这两处此前没传 → 未鉴权的无限缓冲），
  **并按仓内既有房规补 `PayloadTooLargeError → 413` 分支**（`/api/voice/stt` 与两条
  `/api/uploads` 都是这么写的）。只传 cap 不动 `catch` 的话，413 会被那个裸 `catch`
  吞成「400 Invalid JSON body」—— 攻击者和运维看到的都是「JSON 格式错」。

### 2.5 错误码与**文案**

| 情况 | 状态 | code |
|---|---|---|
| 没给（`undefined` / `null` / 空串） | 403 | `setup_token_required` |
| 给了但不匹配，**含类型不对**（`{length:1e9}` 这种） | 403 | `setup_token_invalid` |

message 必须含：`setupToken`（字段名）、`setup-token`（文件名）、「终端」。

**必须*不*含绝对路径、也不含 `~/.zuse`。** 两个理由：authDir 是可变的
（测试就传临时目录，那时指引会指向一个不存在的文件）；这条路由**未鉴权**，
回显真实路径会连带泄露用户名。绝对路径只打在 stderr 横幅上 —— 那是本机才看得到的地方。

两个码**刻意分开**：token 是高熵随机值，区分「没给」和「给错」不泄露任何可利用信息，
而合成一个码会让用户无法判断是漏贴了还是贴错了。

**文案本身要写进测试**（第 1 步已有先例：`originGuard.e2e.test.ts` 断言正文含 `--allowed-host`）。
一个没有可操作指引的 403 = 把远程访问封死。

### 2.6 前端联动 —— 比 v1 说的更严重

`GET /api/auth/status` 增加 `setupTokenRequired: boolean`（**只回布尔，绝不回 token 本体**）。

`AuthGate.tsx` 要改**三处**，前两处是第 1 步就埋下、v1 完全没看见的断链：

1. **status 请求没有 `r.ok` 检查** —— `fetch(...).then(r => r.json())`，403 的 JSON 里没有
   `configured` → `!undefined` → 掉进 **setup 界面**。隧道用户没加 `--allowed-host` 时，
   看到的不是「Host 不在允许列表」，而是一个「保护此服务器」的设密码界面，点下去再吃一个 403。
   → 加 `if (!r.ok) → phase='error'` 并显示 `d.error?.message`。
2. **提交失败只显示 `'错误 ' + r.status`** → 改成显示 `d.error?.message`
   （devPage 一直是对的，v1 说反了，见 §7）。
3. setup 阶段按 `setupTokenRequired` 多渲染一个 token 输入框 + 取回指引。
   **token 只放进 setup 的 body**：login 路由压根不读这个字段，带上只会让这个密钥
   多经过一条链路（HAR、代理日志）。

第 1 条实现时**不能直接 `await r.json()`**：隧道 / 反代用户最可能撞见的是网关自己的
HTML 错误页，那时 `r.json()` 抛，用户看到的是 `Unexpected token '<'` ——
而这次改动的全部意义就是让他们看见真实原因。解析失败要回落到 `错误 <status>`。

`devPage.ts` 需要第 1 条和第 3 条（它的**提交**失败分支本来就显示 `d.error.message`，
但它的 **status** 分支和 AuthGate 一样没看 `r.ok`）。

（`.faint` **不是一个存在的 class** —— 全仓只有 `--faint` 变量。指引那段用裸 `<p>`，
`.auth-card p` 已经给了 `--muted`。写 `class="faint"` 就是又一条「有 class 没规则」，
和回溯审计 E2 的 `.icon-btn.on` 同型。）

## 三、落地清单

| # | 文件 | 内容 |
|---|---|---|
| 1 | `auth/setupToken.ts`（新） | `generateSetupToken()` / `isExposedDeployment()` / `checkSetupToken()`，纯函数 |
| 2 | `http/server.ts` | `deps.setupToken?`；status 加 `setupTokenRequired`；setup 路由校验 + body cap |
| 3 | `startServer.ts` | 暴露形态生成 + 落盘 0600 + 传入 + 横幅；未判暴露且未配置口令时提示 `--allowed-host` |
| 4 | `AuthGate.tsx` / `devPage.ts` | §2.6 的三处 / 一处 |
| 5 | 测试 | 纯函数 + 路由 + **`startServer` 接线**（见 §5.7，这条最容易漏） |
| 6 | `docs/remote-access.md` / `docs/features.md` | 两条隧道配方补 `--allowed-host` + token 一步；面向用户条目（第 1 步也没写，一并补） |

## 四、取舍与代价

- **代价**：隧道 / 局域网用户首次设置口令多一步 —— 回终端（或 `cat ~/.zuse/setup-token`）
  复制一串 token。这是**故意加的摩擦**，换的是「隧道 URL 泄露 ≠ 立刻 RCE」。
- **不做的**：不做 IP 限速 / 封禁（setup 只有一次成功机会，爆破 192 bit 不现实，
  而限速表本身是一个可被打满的内存结构）；不加 `--setup-token <value>`
  （会进命令行 / 进程列表 / 服务单元文件 —— 0600 文件更好）。
- **已知缺口（照实写）**：
  1. §2.1 的两条漏报形态。
  2. token 走明文 HTTP 时可被同网段嗅探。暴露形态本来就该配 TLS 或隧道，
     启动横幅早在警告明文 —— 不是 token 引入的，token 也不打算解决。
  3. §2.2 的多账户主机。
  4. **`--set-password` 与运行中的 daemon 不同步**（评审顺带查出，与本功能相撞）：
     `PasswordStore` 构造时把文件读进内存，`hasPassword()` 只看内存副本。所以在 daemon
     跑着的时候用另一个进程 `--set-password`，daemon 仍报 `configured:false`、页面仍是
     setup 界面、**仍要贴 token**，而这次 setup 会覆盖刚写的 hash。文档要写「先设口令再起 daemon」。
  5. token 只保护 setup。已设口令之后的攻击面由别处管。

## 五、测试点（每条注明「不写它会漏什么」）

1. `isExposedDeployment`：回环三写法 → false；`0.0.0.0` / `::` / **空串** / LAN IP / 域名 → true；
   **回环 + `trustProxy` → true**；**回环 + `allowedHosts` 非空 → true**；
   **回环 + `tlsCert` → true**。漏后三条就漏掉全部隧道形态。
2. `checkSetupToken`：长度不等**不抛**、返回 false（`timingSafeEqual` 会抛，实测过）。
3. `checkSetupToken`：非字符串（含 `{length:1e9}`）返回 false 且**不分配**——
   不写它，一个 35 字节的 body 能把 daemon 冻 6.6 秒。
4. 路由：**未配置 token 时 setup 照常成功** —— 回环形态不能被这次改动打死。
5. 路由：配置了 token 时，缺失 → 403 `setup_token_required`；错误 → 403 `setup_token_invalid`；
   正确 → 200 且口令**真的设上了**（只断言 200 会放过「校验通过但没写」）。
6. 路由：403 正文含可操作指引（`setup-token` 路径 / 终端字样）。
7. **`startServer` 接线**（评审指出的假绿风险，与已修的 iframe sandbox 同型）：
   `trustProxy:true` 的回环 daemon → 不带 token 的 setup **必须 403**；
   裸回环 daemon → **必须 200**。
   前六条全在下游，`startServer` 把判据写反 / 忘了传，它们**一条都不会红**。

   **完整签名不能省，照抄短版会写坏开发者本机**：
   ```ts
   await startServer(
     { host: '127.0.0.1', port: 0, authDir: <临时目录>, tokenTtlSec: 3600, cwd: <临时目录>, trustProxy: true },
     { session: <fake-client session>, connectMcp: false },
   )
   ```
   - **`authDir` 必须是临时目录**：`defaultConfig().authDir` 是 `~/.zuse`，
     用它会往开发者本机真实的 `setup-token` 上写（再叠加删除分支就是把活 token 删了）。
   - **`connectMcp:false` 不能省**：否则要去连开发者真实配置的 MCP server，
     `wsServer.test.ts` 的注释里记着那造成过「整片随机红」。
   - 实测这样是干净的：26 ms 起完，只在临时目录里生成 `web-auth.json` / `web-sessions`，
     `~/.zuse` 零新增。

7b. **同一 authDir 上再起一个本机 daemon，不许删掉暴露 daemon 的活 token**（§2.3.1）。
8. `GET /api/auth/status` 的响应正文**不含** token 字符串 —— 防「`setupTokenRequired` 手滑
   写成 `setupToken`」这类一击致命的手误，现在没有任何东西挡着。
9. **变异验证两处**：① 删掉 setup 路由里的校验段 → 第 5 条红；
   ② 删掉 `startServer` 里生成/传入的那几行 → 第 7 条红（第 1 处变异抓不到它）。

## 六、真跑验证（测试绿 ≠ 能用）

- `--host 127.0.0.1 --trust-proxy` 起一个真 daemon（临时 authDir）：curl 不带 token → 403 且
  正文有指引；`cat <authDir>/setup-token` 拿到值 → 带上 → 200；再 login → 200。
- 默认回环 daemon：setup 不带 token → 照常成功（不能打死本机开发）。
- 真浏览器走一遍 AuthGate 的三条改动（含把 status 打成 403 时的错误界面）。

## 七、v1 的三处事实错误（评审推翻，逐条列出）

1. **「删口令文件会让运行中的 daemon 重开 setup 门」—— 假的。** `PasswordStore` 构造时
   把文件读进内存，`hasPassword()` 只看内存副本。实测：删文件后同一实例仍报 `true`，
   只有新实例才是 `false`。「无条件生成」这个结论保留，但理由换成真的（§2.3）。
   —— 这与回溯审计主线 B 修的四条同型：**取舍论证建立在一个可被一行命令证伪的前提上**。
2. **「devPage 只显示『错误 403』」—— 说反了。** devPage 一直显示 `d.error.message`；
   **瞎的是 AuthGate**，而且比 v1 想的严重（§2.6）。
3. **「宁可误报要求 token，不可漏报」—— 做不到。** §2.1 列出两条真实漏报形态。

## 七之二、v2 的补救带进来的问题（第二轮评审，只审补救本身）

补救是**设计者自己选的**，所以第二轮只问一件事：这些补救对不对、有没有引入新洞。
查出 8 条，其中一条是**真 bug**：

1. 【真 bug】token 文件的删除分支**跨实例互删**，正好打死落盘存在的理由（§2.3.1）。
   评审实测复现，已修 + 加了回归测试 + 变异验证。
2. 【假前提】Windows 上 `chmodSync(0o600)` 对访问控制**完全无效**（§2.3 的表）。
   —— 又一条「取舍建立在可被一行命令证伪的前提上」。
3. 【自相矛盾】§2.5 硬编码 `~/.zuse/setup-token`，与实现刻意的做法冲突（§2.5 已改）。
4. 【陷阱】§5.7 的短签名照抄会写坏开发者本机的真 token（§5.7 已补全）。
5. §2.3「无条件生成」与「只在未配置时产出」自相矛盾，隐含依赖没写出来（§2.3.1 补）。
6. §2.5 的「类型不对 → required」与实现不符（改 spec，§2.5）。
7. §2.4 只说「加 cap」，不说 413 分支 → 下一条路由会重新把 413 吞成 400（§2.4 补）。
8. §2.6 的 `r.ok` 检查没说 body 可能不是 JSON（§2.6 补）。

第二轮**确认干净**的补救：§2.1 加的两条判据（四条隧道配方全命中、零误伤）、
类型校验挡 DoS（顺序正确）、AuthGate 的 `r.ok`（不会误伤 401，因为 status 路由无条件 200）、
§5.7 的接线测试可写且变异隔离干净、启动提示不会成噪音（只在未设口令时出现）。

## 八、修订记录

- v1（2026-08-14）：初稿。
- v3（2026-08-14）：第二轮评审只审 v2 的补救 —— 8 条，含一条真 bug（跨实例删 token 文件）。
- v2（2026-08-14）：按独立评审的 12 条重写 —— 判据加两条 + 诚实列漏报、token 落盘 0600、
  类型校验挡 DoS、AuthGate 三处断链、错误文案入测试、`startServer` 接线测试 + 第二处变异、
  docs 进落地清单、三处事实错误列明。
