# 03 · 在 `w.stalkerai.cn` 上部署（Flutter web 优先）

> **结论：可以，而且条件是具体的、很少的。** 现成的模板已经跑着两个站（`u.` 和 `v.`），
> 我把它读了一遍，`w.` 照抄即可。
>
> ⚠️ **但 VPS 上跑着 13 个别的站**，改 nginx 会碰到别人。
> 按手册 **P1/P2**（改运行中的系统要主人签字），**这一步等你点头再动**。

---

## 一、先说现状：`w.stalkerai.cn` 现在是什么样（都是实测）

| 项 | 状态 |
|---|---|
| **DNS** | ✅ **已经解析到 `120.26.179.211`**（VPS）——不用配域名 |
| **HTTP :80** | ⚠️ 200——那是 nginx 的**兜底页**（`zzz-catchall`），不是我们的 |
| **HTTPS :443** | ❌ `tlsv1 unrecognized name` ⇒ **没有证书、也没有 server 块** |
| **证书** | ❌ `/etc/letsencrypt/live/` 里有 13 个域，**没有 `w`** |
| **VPS 端口 3084** | ✅ **空着**（3081 本机 GUI、3082=`u`、3083=`v`） |

⇒ `w.` 是一张**干净的白纸**，这正是最好做的情况。

---

## 二、`u.` / `v.` 是怎么做的（照抄这个）

**核心是 frp 的 `stcp`（secret TCP）——它不占任何公网端口。**

```
浏览器
  │ HTTPS 443
  ▼
VPS: nginx  ── proxy_pass ──►  127.0.0.1:3082   ← frp stcp **visitor**（只绑回环）
                                      ▲
                                      │ frps :7000（VPS 上的 frp 服务端）
                                      │
                                frpc（本机）────► 127.0.0.1:3081   ← 真正干活的服务
```

**为什么用 stcp 而不是普通的 tcp 转发**：普通 tcp 会在 VPS 上开一个公网端口，
**那就绕过了 nginx**（也就绕过了 TLS、认证、限流）。
stcp 只让本机的 `frpc` 和 VPS 上的 `visitor` 对话，**中间那一跳不暴露在公网上**。

### 两侧各自要什么

| 侧 | 文件 | 关键字段 |
|---|---|---|
| **本机** | `~/.local/frp/frpc-<名>.toml` | `[[proxies]] type="stcp"`、`secretKey`、`localIP=127.0.0.1`、`localPort=<本地端口>` |
| **VPS** | `/opt/frp/frpc-visitor-<名>.toml` | `[[visitors]] type="stcp"`、`serverName`（=本机 proxy 的 name）、**同一个 `secretKey`**、`bindAddr=127.0.0.1`、`bindPort=308X` |
| **VPS** | `systemd: frpc-visitor-<名>.service` | 起上面那个 visitor |
| **VPS** | `/etc/nginx/conf.d/<名>-stalkerai.conf` | 80→301、443 ssl + 证书、`proxy_pass http://127.0.0.1:308X` |
| **VPS** | 证书 | `/etc/letsencrypt/live/<域>/` |

**一个域名一个实例**（`u` 和 `v` 就是各一份，互不影响——改一个不用重启另一个）。
这个设计值得保留：它让"加一个站"变成**纯追加**，不会碰到已有的站。

---

## 三、`w.` 的具体方案

| # | 要做 | 在哪 | 谁做 |
|---|---|---|---|
| 1 | 本机服务监听 `127.0.0.1:8020`（就是 `v2/services/core`） | 本机 | 我 |
| 2 | Flutter web 产物放进 `webRoot`，由同一个服务静态服务 | 本机 | 我 |
| 3 | `~/.local/frp/frpc-w.toml`（stcp，`localPort=8020`） | 本机 | 我 |
| 4 | `/opt/frp/frpc-visitor-w.toml`（visitor，`bindPort=3084`） | VPS | 我（要 root） |
| 5 | `frpc-visitor-w.service` | VPS | 我（要 root） |
| 6 | `certbot` 给 `w.stalkerai.cn` 签证书 | VPS | 我（要 root） |
| 7 | `/etc/nginx/conf.d/w-stalkerai.conf` | VPS | 我（要 root） |

**`secretKey` 要生成一个新的**（不是复用 `u`/`v` 的）——它们是隔离用的，
共用一个等于把三个站绑在一根绳上。

---

## 四、⚠️ 风险与纪律（**VPS 上有 13 个别的站**）

| # | 纪律 |
|---|---|
| **1** | **只新增文件，绝不改已有的 conf**——不碰 `u-`、`v-`、`hupo-`、`dsh-` 等 |
| **2** | 改完 nginx **先 `nginx -t`**，通过了才 `systemctl reload nginx`（**reload，不 restart**） |
| **3** | `certbot` 用 **`--cert-name w.stalkerai.cn`** 单独签，不碰别的证书 |
| **4** | 出问题**一条命令回退**：删掉新增的那两个文件 + reload |
| **5** | **`stcp` 不占公网端口** ⇒ 不会和别的站抢端口 |

**回退**（如果哪里不对）：
```
ssh root@120.26.179.211 '
  rm -f /etc/nginx/conf.d/w-stalkerai.conf
  systemctl disable --now frpc-visitor-w
  rm -f /opt/frp/frpc-visitor-w.toml /etc/systemd/system/frpc-visitor-w.service
  nginx -t && systemctl reload nginx'
```

---

## 五、为什么"Flutter web 优先"正好合适

手册 D4 说：**手机是主目标设备，平板是主开发设备**。
而 web 端是**最快能看到、能验收**的那一个——不用装 APK、不用签名、不用等商店。

⇒ 顺序：**web 先出来 → 用真机浏览器验收 → 再生成 Android 包**。

⚠️ 有两件事 web 端**天然做不到**，所以它们必须**推后到 Android 那一步，不能假装做了**：

| # | web 上做不到 | 什么时候做 |
|---|---|---|
| 1 | **按住说话的语音输入**（要系统识别器 + 麦克风权限） | Android |
| 2 | **通知**（后台任务做完了要告诉你） | Android |
| 3 | ⚠️ **离线可用**（Service Worker 能让它半可用，但**不能承诺**） | 存疑，别写进文案 |

手册 D3.3 有一条要记住：**语音没上线之前，关于页必须明写"不会拼音的人这个版本用不了"**——
web 版同样适用，**不许因为"反正 web 是临时的"就把这句话省掉**。

---

## 六、下一步（需要你点头的那一步）

我**可以**一次把上面 1–7 全做完（本机 + 通过 SSH 到 VPS，root 权限已确认可用）。

**但它会改动服务着 13 个站的那台机器**，所以按手册 P1/P2，我先问。

要我做的话，回一句"铺"，我就：
1. 本机起服务（fail-closed 状态）
2. 铺 `frpc-w.toml` + VPS 侧 visitor/unit/证书/nginx
3. 用 `curl` 从**公网**验一遍：`https://w.stalkerai.cn` 能开、`/api/say` 仍然是 503（还没设密码）
4. 回来告诉你结果

**Flutter web 前端本身**还没写——那是接下来的活（`v2/` 下新建 app）。
先铺路还是先写前端，你定；**我建议先铺路**，因为**越早能公网打开，越早能发现真问题**。
