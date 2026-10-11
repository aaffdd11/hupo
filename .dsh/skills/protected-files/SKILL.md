---
name: protected-files
description: 这个仓库里「哪些文件是开机受保护的、改完要请主人重建清单、哪些只是只报不拦」，以及重启线上服务时必须核的那几样（服务必须归 systemd 单元管）。当你要改 AGENTS.md / 手册 / 人格 / DSH profile，或者要重启线上服务时用它。
whenToUse: 要改 AGENTS.md / docs/handbook*/ / hupo-persona.yml / ~/.dsh/profiles/*/cordis*.yml；或者要重启线上服务前后。
---

# 受保护文件 与 重启线上服务

> 权威出处：`AGENTS.md` §八 · `docs/dev/19-P1-P2.md` · `docs/dev/231-RESTART-CGROUP.md` ·
> `v2/services/core/src/integrity.js`（**哪些是 `strict` 以它为准**）。

## 一、先分清两档（`src/integrity.js` 是唯一出处）

| 档 | 有哪些 | 改完要做什么 |
|---|---|---|
| **`strict`**（对不上 ⇒ **拒绝启动**） | `AGENTS.md` · `docs/handbook/**` · `docs/handbook-v3/**` · `hupo-persona.yml` · `hupo-capabilities.yml` · `hupo-model-proxy.yml` · `hupo-app-agent.yml` · `~/.dsh/profiles/*/cordis*.yml` | **要请主人跑一次 `--build`**（见 §三） |
| **`report`**（只报不拦） | `v2/services/core/src/**` · `scripts/**` · 客户端 · `docs/dev/**` | 什么都不用做（横幅会多一行"有 N 个只报不拦的条目动过"） |

读当前状态（**只读**）：`node scripts/verify-integrity.mjs` ⇒ 要的是 **✅ 对上了**
（0 处会拒绝启动、0 处漏条）。⚠️ **"清单漏了 N 条"比"内容变了"更坏**：那是"写着有、其实没在核对"。

## 二、🔴 口令不许到助手这儿来

`sudo` **要密码**，而本机**没有系统 `node`** ⇒ 命令里必须写**绝对路径**。
助手**不试免密、也不要口令**：把那条命令**原样**交给主人，他跑。
（`verify-integrity.mjs` 自己会把那条命令打出来，**照它粘**，别手打。）

⚠️ 攒着别每批都烦他：受保护文件的改动**攒起来一次说**，记在 `docs/dev/00-PROGRESS.md` §九。

## 三、重建那一步（主人跑）

```bash
sudo /home/deploy/.nvm/versions/node/v24.15.0/bin/node /home/deploy/proj/hupo/scripts/verify-integrity.mjs --build
```

跑完**两条都要核**（别只看第一条）：
1. `node scripts/verify-integrity.mjs` ⇒ **✅ 对上了**；
2. 重启 ⇒ 查**退出码**，再核：横幅写「**完整性 对上了**」、本机 8020 与公网都 **200**。

## 四、重启线上服务（本机 8020 ＝ `w.stalkerai.cn`）

```bash
bash scripts/restart-core.sh          # ⚠️ 默认保留日志（跨重启记忆靠它）；--fresh 会清空
```

🔴 **跑完必须核这一样**（2026-10-11 真栽过 —— 服务被起进了 `dsh-subprocess-*.scope`）：

```bash
cat /proc/$(systemctl --user show hupo-core -p MainPID --value)/cgroup
#   ⇒ …/app.slice/hupo-core.service     ← 这才对
systemctl --user is-active hupo-core    # active
```

**为什么这条最要紧**：掉出单元 ⇒ ①脱离 `Restart=always`（崩了没人拉）②那个 DSH scope 一收它跟着死
③指纹 drop-in 不再更新。
⚠️ **别用裸的 `systemctl --user stop`（不带单元）**：那会顺手清掉 DSH 的 scope，把正在跑的活一起杀掉。

## 五、收尾时的那句话

> 「改了 X 份受保护文件 ⇒ 要你补一条重建命令」＋ **那条命令** ＋ **跑完怎么核**。
> 短到主人愿意看一眼 —— 这是这条纪律唯一能活下来的形状。
