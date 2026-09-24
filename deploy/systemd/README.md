# 开机自启：三个 systemd **用户**单元（草案 · P2-7 · 2026-09-24）

> ⚠️ **这是草案，等主人签字**（`docs/dev/76-PLAN.md` §四 P2-7）。
> 助手**不自己装** —— 装它等于改"开机自动读"的那条路（`AGENTS.md` §八）。

## 一、它解决什么

现在服务与两条隧道都是**手动起的**（`scripts/restart-core.sh` / `scripts/start-tunnels.sh`，
它们顶上各自写着"**这个脚本不解决开机自启**"）。⇒ **机器一重启＝整站 502**、公网握手全断，
得你上机器手动拉一次。三个单元就是拿来自启的。

| 单元 | 起什么 | 起在哪 |
|---|---|---|
| `hupo-core.service` | 调度器 `serve.js`（127.0.0.1:8020） | 仓库 `v2/services/core` |
| `hupo-frpc-w.service` | 隧道 `frpc-w`（`w.stalkerai.cn` 那一跳） | `~/.local/frp` |
| `hupo-frpc-apps.service` | 隧道 `frpc-apps`（制品口那条） | `~/.local/frp` |

三个文件都过了 `systemd-analyze verify`（2026-09-24 实测：**无输出**＝没有语法/依赖问题）。

## 二、怎么接管（**顺序别换**）

```bash
# ① 装进用户单元目录
mkdir -p ~/.config/systemd/user
cp /home/deploy/proj/hupo/deploy/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload

# ② 🔴 **先停旧的**（restart-core.sh 起的那个）—— 否则两个抢 8020
#    先看它在不在（按 PID 文件走，**不许 pkill -f**：那会把自己也杀掉，本仓库点过名）
cd /home/deploy/proj/hupo/v2/services/core && [ -f serve.pid ] && kill "$(cat serve.pid)" && sleep 2

# ③ 起三个单元，并让它们开机自启
systemctl --user enable --now hupo-core hupo-frpc-w hupo-frpc-apps

# ④ 🔴 **让"没登录"也能自启**（用户单元默认要有人登录才跑）
sudo loginctl enable-linger deploy
```

## 三、判据（P2-7 原本要的那条 ＋ 两条加严）

```bash
systemctl --user list-unit-files | grep -E 'hupo-(core|frpc)'   # 三条都在、都是 enabled
systemctl --user status hupo-core --no-pager | head -5           # active (running)
curl -s -o /dev/null -w '%{http_code}\n' https://w.stalkerai.cn/api/version   # 200
pgrep -af src/serve.js                                            # **只该剩一个**（systemd 那一个）
```
⚠️ 最后一条很重要：**只该剩一个**。剩两个＝旧那个没停干净（两个抢端口，谁先拿到看运气）。

真正的判据（P2-7 原话）：**机器重启之后公网仍然 200**。那一步只有你能做（要重启这台机器）。

## 四、怎么退回去（一次一条）

```bash
systemctl --user disable --now hupo-core hupo-frpc-w hupo-frpc-apps
rm ~/.config/systemd/user/hupo-*.service && systemctl --user daemon-reload
bash /home/deploy/proj/hupo/scripts/restart-core.sh      # 回到手动那条路
bash /home/deploy/proj/hupo/scripts/start-tunnels.sh
```

## 五、三个坑（都写在这儿，别踩）

1. 🔴 **不许用 `systemctl --user stop` 去清 DSH 的 scope**（`AGENTS.md` §一）：
   线上服务原来就活在那种 cgroup 里，随手一停可能**把别的会话一起杀掉**。
   这个单元接管之后就没这回事了 —— 但那之前别去碰那些 scope。
2. ⚠️ **`~/.local/frp/*.toml` 里有 secretKey（0600）**：单元只**读**它，
   `systemctl status` 也不会打印 env ⇒ 不泄密。**别**把 toml 内容贴进任何日志/文档。
3. ⚠️ **改了 `docs/handbook/**` / 人格 / 这个能力层之后**要先重建开机清单再重启
   （否则 `serve.js` 会**拒绝启动** —— 单元的 `Restart=always` 会一直撞那面墙，
   日志里刷 `✗ 起不来：`）。重建命令见 `docs/dev/00-PROGRESS.md` §九。
