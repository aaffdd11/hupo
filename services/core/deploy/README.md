# S0 止损：系统级改动（可复现版）

> 这些改动有一半在 `/etc` 里（systemd / nginx），**不在仓库里就等于随时会丢** ——
> 所以在这里留一份权威副本 + 安装命令 + **每条防的是什么**。
>
> 为什么先做这一批：近 7 天实测 **OOM 4 次**，受害者每次都是 agent 自己起的 Flutter 编译器；
> 根因是单元文件里**没写** `OOMPolicy`（默认 `stop`）—— 它把"一个构建进程被 OOM"
> 升级成"整个助理停机 + 3 秒后重启 + 把同一件重活原样重派一遍"。

## 一、文件与落点

| 仓库里的文件 | 装到哪 | 怎么装 |
|---|---|---|
| `concierge-core.service` | `/etc/systemd/system/concierge-core.service` | `sudo cp … && sudo systemctl daemon-reload` |
| `build.slice` | `/etc/systemd/system/build.slice` | 同上 |
| `nginx-security-headers.conf` | `/etc/nginx/snippets/hupo-security-headers.conf` | `sudo cp … && sudo nginx -t && sudo systemctl reload nginx` |
| `nginx-hupo-stalkerai.patch` | 打到 `/etc/nginx/conf.d/hupo-stalkerai.conf` | `sudo patch -b -p0 < …`（**注意备份**） |

## 二、每条改了什么、防的是什么

### 1. `OOMPolicy=continue`（一行，最重要）

**默认值是 `stop`**，而且单元文件里一个字都没写 —— 所以它不写在任何人眼皮底下。
后果：cgroup 里任一进程被 OOM ⇒ systemd 认为**整个单元**失败 ⇒ 停掉整个 cgroup
（调度器 + 所有 agent 陪葬）⇒ 主人页面变灰说"正在恢复连接" ⇒ `Restart=always` 3 秒后重启
⇒ 启动对账把刚才那件重活**原话重派**（`resumePrompt` 还要求"验证生效"）⇒ 又 OOM。

改成 `continue`：一个子进程死就死它，**调度器活着把这一轮如实收口**。

### 2. `MemoryHigh=640M` / `MemoryMin=256M` / `MemorySwapMax=0`

原来只有 `MemoryMax=1G` 这个**硬限**：到点就杀，中间不做任何软性回收/节流。
`MemoryHigh` 让内核先回收、先节流，而不是直接动手。

### 3. `StartLimitIntervalSec=300` + `StartLimitBurst=6` + `RestartSec=5`

原配置 `RestartSec=3` 配 systemd **默认**熔断 `5 次 / 10 秒`：
3 秒间隔下凑满 5 次要 **12 秒 > 10 秒窗口** ⇒ **systemd 自带的循环保护永远不生效**，
理论上可以无限 3 秒一轮。现在窗口 5 分钟 / 6 次，撞上就停在 failed（要人工 `reset-failed`），
而不是空转。

### 4. `OOMScoreAdjust=-500`

这台机器 **7.2G / 0 swap**，邻居不少（harness 1.05G、dsh-web 908M…）。
全机 OOM 时内核可以杀任何进程，`0` 意味着我们没有任何优先级保护。

### 5. `build.slice` + `deploy-web.sh` 里的 `systemd-run --scope`

**这是"1 个会话 + 一次构建 = 1086MB > 1024MB ⇒ 必然 OOM"的那一半。**
Flutter 工具链 ~846MB 原来和调度器 + agent 挤在同一个 1G 里。
现在构建跑进 `build.slice`（2G / CPUQuota 300% / CPUWeight 20 / IOWeight 20），
身份仍是 `deploy`（不产生 root 属主的构建产物）。

顺带解决 CPU：实测构建期间 `nr_throttled/nr_periods = 9439/10428 = 90.5%`，
构建和主人的对话抢同一份 CPU，直接把"首句 ≤6s / 空窗 ≤8s"这条纪律打穿。
`CPUWeight=20` 让主人的那句先跑。

### 6. `deploy-web.sh` 的另外三处

- `--exclude=/apps/`：`rsync -a --delete` 会把制品目录整棵抹掉，**而且没有报错**；
  同时抹掉"上一版制品长什么样"⇒ 防篡改从第一天起就不可能实现。
- 前置 `df` 检查（可用 <12% 拒绝部署）：装到一半没空间比不部署更糟。
- `data/deploy.log`：`HUPO_DEPLOY_ANYWAY=1` 能一次绕掉两个硬闸，之前**不留痕迹**。

### 7. nginx 安全响应头 + XFF

- 安全头必须 **include 到每个 location**：`add_header` 在 `location` 里会**覆盖**上级，
  那些已经有 `Cache-Control` 的 location 会把 server 级的头整个吞掉（实测踩过这个假象）。
- `X-Forwarded-For $remote_addr`：原来是 `$proxy_add_x_forwarded_for`，
  它把**客户端自带的值前置**、真实对端追加在最后，而服务端取第一跳 ⇒
  攻击者每次换个头就是"新 IP"，"5 次锁 15 分钟"当场失效。
  （服务端也同步改成取**最后一跳**，双保险。）

## 三、装完怎么验（可直接跑）

```bash
# ① 限额真的落到运行中的 cgroup
CG=/sys/fs/cgroup/system.slice/concierge-core.service
cat $CG/memory.high $CG/memory.max $CG/memory.min $CG/memory.swap.max
systemctl show concierge-core -p OOMPolicy -p StartLimitIntervalUSec -p StartLimitBurst

# ② 构建不再跑在调度器的 cgroup 里
sudo systemd-run --scope --quiet --collect --slice=build.slice --uid=deploy --gid=deploy \
  -p MemoryMax=2G -- sh -c 'cat /proc/self/cgroup'      # 应输出 /build.slice/…

# ③ 安全头（两个都要有 —— 第二个验证 location 覆盖陷阱）
curl -sI https://hupo.stalkerai.cn/ | grep -iE 'x-content-type|x-frame|strict-transport'
curl -sI https://hupo.stalkerai.cn/assets/$(curl -s https://hupo.stalkerai.cn/ | grep -o 'assets/[^"]*' | head -1 | cut -d/ -f2) | grep -i x-frame

# ④ 鉴权 fail-closed（用空 dataDir 起临时实例，不要动线上）
cd services/core && CONCIERGE_DATA_DIR=/tmp/x CONCIERGE_PORT=8098 node src/index.js &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8098/api/conversations   # 必须 503
curl -s http://127.0.0.1:8098/api/auth                                            # needsSetup: true
kill %1

# ⑤ 续做闸门与失败豁免（单测）
cd services/core && node --test "test/*.test.js"      # 72 个用例，含 4 条新增
```

## 四、还没做的（本轮 S0 范围之外，但记着）

| 项 | 为什么还没做 |
|---|---|
| `hupo-crash-guard` | 代码侧已支持 `CONCIERGE_SKIP_RESUME=1`（降级启动），**守护脚本本身**属 S3 |
| `hupo-disk-guard` / `hupo-sampler` / `hupo-alert@` | 属 S3（可观测性与磁盘分级） |
| 备份（本地第二目录 + 恢复演练） | 拍板第 11 条，属 S3 |
| 制品搬出站点根 + 独立 origin | 拍板第 9 条的"三件前提"，属 S1 |
| `hupo.chat` 明文 origin 下线 | 本轮未动；它与主站**共用同一棵根**，且是明文 |
| ⚠ **agent 仍挂 `danger-full-access` + 免密 sudo** | 拍板第 6 条只做了"读到外部内容就降权"，没动"agent 自己的手有多大" |
