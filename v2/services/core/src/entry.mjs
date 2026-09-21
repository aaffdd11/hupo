// **把这一台跑起来的那个人**（契约 `docs/dev/45-TENANT-UPDATE.md` · `46-KEY-DELIVERY.md`）。
//
// ── 为什么它在**产品层**，而不是镜像里 ──────────────────────
// 原来这一整段是 `build-tenant-image.sh` 生成进**镜像**的 `entry.mjs`。
// 而它调的全是产品层的模块 ⇒ **改一次"怎么调"就要重造镜像**。
// 2026-09-21 真机连着栽了两层，都是这个形状：
//   ① 钥匙路径的规则写在镜像里的入口里 ⇒ **产品层发布带不动它**；
//   ② `watchForKey({ keyFile: … })` 由入口传参 ⇒ 传的还是镜像里那条旧 env
//      （tmpfs）⇒ 容器日志说"拿到凭据了"，而**卷里没有那个文件**。
// ⇒ 规矩：**镜像里只剩一个薄加载器**（找产品层、把它跑起来），
//    **所有接线与行为都住在产品层**（能不发 root 就更新）。
//
// ⚠️ 这一份只跑在**容器里**（宿主上跑的是 `serve.js`）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 产品层的 `src/` 与它的根（人格 / 能力 / 代理 patch 住在根那一层）。 */
const SRC = import.meta.dirname;
const CODE = nodePath.dirname(SRC);
const inCode = (rel) => nodePath.join(CODE, rel);

// ⚠️ 这几份的默认值都是 `cwd/xxx`，而 cwd 是 `/app`（镜像那份）⇒ 不指过来就会挂错。
//    `??=`：宿主/单元显式给了就听它的（不许悄悄覆盖别人的显式选择）。
process.env.HUPO_PERSONA ??= inCode('hupo-persona.yml');
process.env.HUPO_CAPABILITIES ??= inCode('hupo-capabilities.yml');
process.env.HUPO_LEDGER_SERVER ??= nodePath.join(SRC, 'mcp-ledger-server.mjs');
process.env.HUPO_MODEL_PATCH ??= inCode('hupo-model-proxy.yml');

// ★ **钥匙住哪**：规则住在 `key-path.mjs`（**只有那一处**）。这里只打印实际会用哪个。
try {
  const { keyFileFor } = await import('./key-path.mjs');
  console.log(`  钥匙文件：${keyFileFor()}（**卷里**：重建容器也不丢）`);
} catch {
  console.log('  ⚠️ 读不到 key-path.mjs —— 钥匙那条路可能会按老规矩看 tmpfs');
}

// 卷里的目录：镜像建不了（会被挂载盖住），只能开机建。
// ⚠️ 布局照 `02-ARCHITECTURE.md` §2.1：`main` 与 `workspaces/` **必须平行**
//    （否则主目录的 agent 会写进子工作区——"算错一个相对路径"就发生）。
//    ⚠️ 主目录 root **不是 home**（§2.2 规则 1）：home 当 root ⇒
//       agent 读得到自己的 key、写得进 `.bashrc` = 持久化代码执行。
const data = process.env.HUPO_DATA ?? '/data';
// 🔴 **换手**（②-2）：镜像里设了 `HUPO_AGENT_UID/GID=1000` ⇒ 服务（root）
//    spawn agent 时**把身份降到 1000**。理由：userns 的容器 root 带着
//    `CAP_DAC_OVERRIDE` ⇒ **agent 是 root 时任何权限位都拦不住它读 key**（决策 ①）。
//    ⚠️ 所以下面这几格**必须归 1000**，否则换手之后 agent 连自己的东西都写不了。
//    ⚠️ `/data/dsh` 是 **agent 的 `DSH_HOME`**（镜像里 `DSH_HOME=/data/dsh`）：
//       它也得归 agent —— 而且它只能由**入口**建（`/data` 是 root `0711`，
//       uid 1000 自己建不出这一格）。
const owned = [`${data}/main`, `${data}/workspaces`, `${data}/hupo`, `${data}/dsh`];
for (const d of [data, ...owned]) {
  try { nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}
// 属主照权限席给的：`/data` 是 root `0711`（能穿过去、列不出别人），
// 里面那几样归 **agent(1000) `0700`** —— 服务(root)读得到，别的租户读不到。
//
// 🔴 **`chmod` 必须在 `chown` 之前**：反过来的话，文件已经属于 1000 了，
//    root 再 chmod 就需要 `FOWNER`；而运行时**只带 4 条能力**（没有 FOWNER）。
//    实测见 `docs/dev/39-PERMISSIONS.md` §5.4.1 的 E 组与 I 组。
try { nodeFs.chmodSync(data, 0o711); } catch (e) { throw new Error(`entry: chmod ${data} 失败：${e.code}`); }
for (const d of owned) {
  // ⚠️ **必须幂等**（2026-09-21 真重启才发现的）：
  //    第一次开机时这几格是 root 的，`chmod` 之后再 `chown` 就行；
  //    但**第二次**开机它们**已经属于 agent(1000)** 了，root 再 `chmod` 就需要 `FOWNER`
  //    ⇒ 少了它，**容器第二次就起不来**（报 `EPERM: chmod '/data/main'`），
  //      而现象是"第一次好好的，重启就死" —— 这条只有真重启过才看得见。
  const st = nodeFs.statSync(d);
  const mode = st.mode & 0o777;
  if (st.uid === 1000 && st.gid === 1000) {
    if (mode !== 0o700) nodeFs.chmodSync(d, 0o700); // 已经是他的 ⇒ 这一步要 FOWNER
    continue;
  }
  nodeFs.chmodSync(d, 0o700);          // 此刻还是 root 自己的
  nodeFs.chownSync(d, 1000, 1000);     // 交给 agent
}
// ⚠️ **不许静默**：布局没铺成 ⇒ 边界就不在（而且这条边界是"悄悄失效"型的）。
//    自查一遍，对不上就**拒绝启动**，别让一个"看着像在跑"的盒子起来。
for (const d of owned) {
  const st = nodeFs.statSync(d);
  if (st.uid !== 1000 || st.gid !== 1000 || (st.mode & 0o777) !== 0o700) {
    throw new Error(`entry: ${d} 的属主/权限不对（要 1000:1000 0700，实为 ${st.uid}:${st.gid} 0${(st.mode & 0o777).toString(8)}）—— 拒绝启动`);
  }
}
const ds = nodeFs.statSync(data);
if (ds.uid !== 0 || (ds.mode & 0o777) !== 0o711) {
  throw new Error(`entry: ${data} 应为 root 0711，实为 ${ds.uid} 0${(ds.mode & 0o777).toString(8)} —— 拒绝启动`);
}

// ★ **盒子里的模型代理**（多租户 ②-3）：它**持有**那把 key，而 agent 只有占位符。
//   ⚠️ 在**起服务之前**起它 —— 服务一收请求就可能 spawn agent，
//      那时代理必须已经在听（否则第一句话会撞一个"连接被拒"）。
//   ⚠️ 它自己和 agent 是**两个身份**：代理是 root（这个入口就是 root），
//      agent 是 uid 1000 ⇒ agent 读不到那份 key 文件，但经这个口能用它。
//   ⚠️ 起不来**不许**把整个服务带走（用户还能看到界面，只是模型那条路不通）——
//      但**必须大声说**，不许静默降级。
//   ⚠️ **2026-09-22 起：key 文件住进卷里**（`/data/creds.yaml`，root 0600）——
//      原来是 tmpfs（"故意不落盘"），而**容器一重建就没了**（主人被坑过）。
//      契约与代价：`docs/dev/46-KEY-DELIVERY.md` §二。决策 ①（agent 读不到）**没动**：
//      agent 是 uid 1000，而文件是 root 0600、`/data` 是 root 0711（它连列都列不出来）。
try {
  nodeFs.mkdirSync('/run/hupo', { recursive: true, mode: 0o700 });
} catch { /* 挂载点上建不了是正常的（podman 已经建好了） */ }
// ★ **领配置**（多租户 ②-4）：连回宿主那条通道，把这一台的模型凭据领回来，
//   写进 `/data/creds.yaml`（**卷** · root 0600 ⇒ 重建容器也不丢）。
//   ⚠️ **这是主人说的那五步的第 ②③④ 步**：容器起来是个空壳 ⇒ 等着 ⇒ 配置到了才往下走。
//   ⚠️ 领不到**不许**把服务挡住：界面照常起来，只是模型那条路会**如实**说不通
//      （`model-proxy` 没 key 时回 503 而不是去打扰上游）。
//   ⚠️ 宿主上没有 `HUPO_CHANNEL` ⇒ 这一整段不执行（宿主行为逐字不变）。
const channel = process.env.HUPO_CHANNEL ?? '';
if (channel) {
  try {
    const { watchForKey } = await import('./tenant-shell.mjs');
    // ⚠️ **故意不 await**：它是**后台**的，界面要照常起来。
    //    容器要一直跑着（池子那个形状），而用户可能几分钟后才填 key ——
    //    只领一次的话那台容器就永远没有凭据，直到有人手动重启它。
    watchForKey({
      socketPath: channel,
      // ⚠️ **不传 `keyFile`**：它的默认值就是那条规则（`key-path.mjs`）。
      //    传反而多一处能传错的地方 —— 2026-09-21 就是传错了（传的镜像里那条旧 env）。
      attemptMs: Number.parseInt(process.env.HUPO_CHANNEL_WAIT_MS ?? '60000', 10),
      log: (m) => console.log(m),
    });
  } catch (err) {
    console.error(`  ⚠️ 领配置那一步没做成：${err?.message ?? err}（界面照常，模型那条路会说不通）`);
  }
}

try {
  const { startModelProxy } = await import('./model-proxy.mjs');
  await startModelProxy({ log: (m) => console.log(m) }).listen();
} catch (err) {
  console.error(`  ⚠️ 模型代理没起来：${err?.message ?? err} —— 模型那条路会不通（界面照常）`);
}

// 起真正的服务（**同一个进程**，不多一层 shell）
await import('./serve.js');

// ★ **数据面那条隧道**（②-4b 后半）：宿主把用户的请求经通道送进来，
//   这里把它们接到**本机那个刚起来的服务**上。
//   ⚠️ 放在 `serve.js` **之后**：隧道是按需连本机端口的，服务没起来时
//      开进来的隧道会连不上 —— 晚一点起就没有这个窗口。
//   ⚠️ 起不来**不许**把服务带走：界面（本机那套）照常，只是"从外面进来的请求"不通，
//      而那种状态**必须说得出来**（这一行就是那句话）。
if (channel) {
  try {
    const { runTunnelAgent } = await import('./tenant-tunnel-agent.mjs');
    // ★ **"宿主说有新的一版，重开一下吧"**（契约 `docs/dev/45-TENANT-UPDATE.md` §三）。
    //   ⚠️ 退不退由**这边**定：先把手上那一轮说完（读 `/data/status.json`，那个服务自己写的）。
    //   ⚠️ `onReady` = 跟宿主报过到了 ⇒ **从那以后才认那句话**。
    //      不这么写就是**开机死循环**：宿主手上可能还挂着上一轮的"要它重开"，
    //      一开机就退、退完又报、报完又叫 …… 永远起不来。
    //   ⚠️ 拿不到重开那支模块**不许**把隧道带走（大不了就是这一台不自动更新，
    //      而宿主会一直如实说"它还是旧版"）。
    let onReload = null;
    let onReady = null;
    try {
      const { createReloader } = await import('./tenant-reload.mjs');
      const reloader = createReloader({
        statusFile: nodePath.join(process.env.HUPO_DATA ?? '/data', 'status.json'),
        log: (m) => console.log(m),
      });
      onReload = () => reloader.please();
      onReady = () => reloader.arm();
    } catch (err) {
      console.error(`  ⚠️ 自动更新那一步没装上：${err?.message ?? err}（这一台不会被叫着重开）`);
    }
    runTunnelAgent({ socketPath: channel, log: (m) => console.log(m), onReload, onReady });
  } catch (err) {
    console.error(`  ⚠️ 数据面那条隧道没起来：${err?.message ?? err}（本机照常，外面进不来）`);
  }
}
