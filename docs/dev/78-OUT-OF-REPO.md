# 78 · **不在仓库里的那些东西**（"线上 ↔ 仓库"对表 · P1-17）

> 为什么要这一页：这个仓里 **99% 的东西是代码与文档**，但线上跑起来还依赖**几样机器状态** ——
> 它们**不在 git 里**，所以"仓库长什么样"和"线上在跑什么"**不是同一件事**。
> 不写下来，下一个人（或下一个我）就会**在本机到处找它们而找不到**，
> 或者更坏：**以为改完代码就完了**。

## 一、清单（唯一的那几样）

| # | 是什么 | 住在哪 | 谁改 | 怎么验它是对的 |
|---|---|---|---|---|
| 1 | **VPS 的 nginx**（公网那一跳） | `120.26.179.211`:`/etc/nginx/conf.d/w-stalkerai.conf` | **主人**（`ssh` 上去改）· 抄本在 `deploy/nginx-w-stalkerai.conf` | `nginx -t` ⇒ `systemctl reload nginx` ⇒ 公网 `wss://…/api/asr` 回 `asr/unavailable` + `close:1000` |
| 1·补 | 🔴 **抄本必须逐字节照抄**（2026-09-24 对表当场抓到的） | `deploy/nginx-w-stalkerai.conf` 一开始我**在里面加了自己的注释**（"为什么这样写"那些）⇒ `bash scripts/check-nginx-drift.sh` 一跑就报"不一致"。⚠️ 那样对表就没意义了（真漂了也看不出来，全是注释差异）⇒ **抄本＝照抄**，注释搬到本页。现在实测 **✓ 逐字节相同** | 改完跑 `bash scripts/check-nginx-drift.sh`（0 = 对得上 · 1 = 不一致 · 3 = ssh 不通）|
| 1·补2 | **两处历史**（原来写在抄本里的，搬来这儿） | ① `location ~ ^/api/(stream|asr)$`：原来只写 `= /api/stream`（精确匹配）；加 `/api/asr` 时忘了它 ⇒ **本机直连一切正常、公网握手就断**（浏览器只看到 `1006`），而页面上写着"开不了麦克风"（**页面在说假话**）⇒ 主人 2026-09-23 当场授权改这一行，备份 `w-stalkerai.conf.bak-20260923215845`。② **不许用 http 级的 `map`**：那台 VPS 还跑着别的站点，会和别人的定义撞车 ⇒ WebSocket 单独一段，只管这两条路径。⚠️ **以后再加任何 WS 路径，都要回来改那一行**（漏了的表现就是"本机好好的、公网握手断"）|
| 1·补3 | **B7 已做**（2026-09-24）：`scripts/check-nginx-drift.sh` —— 读 VPS 那份、与仓库抄本逐字节比，不一致就报红并打差异（`--diff`）。**只读**（不写、不 reload、不 sudo） | 已实测跑过一次：先报"不一致"（就是上面那条），照抄回去之后 **✓ 对得上** |
| 2 | **frp 隧道**（本机 → VPS） | `~/.local/frp/frpc-{w,apps}.toml`（`0600`，里面有 secretKey） | 本机 · `bash scripts/start-tunnels.sh` | 公网 `/api/version` → 200；`apps.` 那个 → 404（未知路径 = 制品服务在答） |
| 3 | **开机完整性清单** | `/etc/hupo/integrity.json`（`root:root 0444`） | **主人**（`--build`，一条 `sudo`） | 开机横幅写「完整性 对上了」；`verify-integrity.mjs` 退出 0 |
| 4 | **凭据**（语音那三样） | `v2/services/core/data/asr.env`（`0600`，`.gitignore` 里） | **主人自己写** | 重启横幅报「APPID 有 · SECRET_ID 有 · SECRET_KEY 有」（**只报有没有，不报值**） |
| 5 | **租户表** | `v2/services/core/data/tenants.env` | 本机 | `HUPO_TENANT_MAP` 与 `data/users.json` 对得上 |
| 6 | **DSH 自己的 profile / 凭据** | `~/.dsh/**`（其中 `profiles/**` 是 `strict`） | 主人 | `check-persona.sh` 通过 |

## 二、⚠️ 两条纪律

1. **改完仓库里的代码 ≠ 线上变了**：客户端要 `deploy-web-v2.sh`（现在它**自己会先跑两道硬闸**），
   服务端要 `restart-core.sh`。
2. **改完 `strict` 那几样（手册 / `AGENTS.md` / 人格 / `~/.dsh/profiles`）⇒ 必须重建清单**
   （否则**下次重启会被自己拒**）。每次重建都要留痕（`00-PROGRESS.md` §九·补4）。

## 三、🔴 一处**已知的例外**（要主人确认）

**"配置页四个 tab"的客户端那一半，源码不在仓库里**（`77-BLOCKERS.md` B1）：
那次越界提交自己写着"客户端那半源码**被别的会话抹掉**，待重做"。
⇒ 也就是说：**这一块曾经存在过、后来没了**，而它**没有被任何文档记下来**（除了这一行）。
⚠️ 在 B1 拍板之前，`/api/space` 回 `creds:{model,image,video,voice}` 那一半也**不做**（服务端与客户端要一起动）。
