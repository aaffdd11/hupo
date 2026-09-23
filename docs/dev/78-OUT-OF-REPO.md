# 78 · **不在仓库里的那些东西**（"线上 ↔ 仓库"对表 · P1-17）

> 为什么要这一页：这个仓里 **99% 的东西是代码与文档**，但线上跑起来还依赖**几样机器状态** ——
> 它们**不在 git 里**，所以"仓库长什么样"和"线上在跑什么"**不是同一件事**。
> 不写下来，下一个人（或下一个我）就会**在本机到处找它们而找不到**，
> 或者更坏：**以为改完代码就完了**。

## 一、清单（唯一的那几样）

| # | 是什么 | 住在哪 | 谁改 | 怎么验它是对的 |
|---|---|---|---|---|
| 1 | **VPS 的 nginx**（公网那一跳） | `120.26.179.211`:`/etc/nginx/conf.d/w-stalkerai.conf` | **主人**（`ssh` 上去改）· 抄本在 `deploy/nginx-w-stalkerai.conf` | `nginx -t` ⇒ `systemctl reload nginx` ⇒ 公网 `wss://…/api/asr` 回 `asr/unavailable` + `close:1000` |
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
