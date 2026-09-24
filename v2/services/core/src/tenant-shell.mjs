// **容器那一侧的"空壳"**（多租户 ②-4）：开机连回宿主，等自己那份配置。
//
// 这就是主人要的那个形状（`37-MULTITENANT.md` §12.1）：
//
//     ① 容器起来 —— 是个**空壳**（没有 key、没有用户数据）
//     ② 里面那个服务先等（它就是个"配置入口"，还不干正事）
//     ③ 用户在网页上填**自己的** key ⇒ 中心当管道送进那个入口
//     ④ 入口把 key 放到该在的地方（`<HUPO_DATA>/creds.yaml`，**卷** · root 0600 —— `key-path.mjs`）
//     ⑤ 这才启动真正那套服务
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① 🔴 **key 只写进那个文件**，不进日志、不进 env、不回显（本文件里它只以变量形式存在）；
//   ② **等不到就如实返回 `false`**，不许假装成功 —— 上层会照实说"模型那条路不通"，
//      而**界面照常**（用户能看到自己的东西，只是它暂时不会答话）；
//   ③ **不抛**：连不上 / 对面说了听不懂的话 ⇒ 都是 `false`，把"起不来"和"没配置"分开。

import nodeFs from 'node:fs';
import nodeNet from 'node:net';

import { mergeCreds } from './creds.mjs';
import { adoptKeyFile } from './key-path.mjs';

/** `creds.yaml` 里那个字段名（`model-proxy.mjs` 的 `parseKey` 认得它）。 */
export const KEY_FIELD = 'HUPO_MODEL_KEY';

/**
 * 把 key 写进它该在的地方。**原子写 + 0600**。
 *
 * ⚠️ 先写 `.tmp` 再 `rename`：代理是**每次请求现读**的，
 *    直接写会让它读到半个 key（然后拿半个 key 去请求上游）。
 */
export function writeKeyFile(keyFile, key, fs = nodeFs) {
  const tmp = `${keyFile}.tmp`;
  fs.writeFileSync(tmp, `${KEY_FIELD}: ${key}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, keyFile);
  return true;
}

/**
 * **一整包凭据写进去**（P1-29 · 2026-09-24）：模型钥匙 ＋ 语音三样 ＋ 图片/视频。
 *
 * ── 为什么必须"合并"而不是"重写" ────────────────────────────
 *   `writeKeyFile` 是**整份重写**（只写 `HUPO_MODEL_KEY` 那一行）——
 *   ⇒ 每次送钥匙都会把**别的几样抹掉**（这正是"租户那半接不上"的第二个原因）。
 *   这里改成：先读现有的，**只改要给的那几个字段**，别的行原样留着。
 *
 * ⚠️ 规则只住一处：字段名与"什么值算数"都在 `creds.mjs`（`mergeCreds` / `parseCreds`）。
 * ⚠️ 原子写 + 0600（盒子里的代理是**每次请求现读**的 ⇒ 不能让它读到半个文件）。
 */
export function mergeKeyFile(keyFile, patch, fs = nodeFs) {
  let text = '';
  try {
    text = fs.readFileSync(keyFile, 'utf8');
  } catch {
    text = '';
  }
  const next = mergeCreds(text, patch);
  const tmp = `${keyFile}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, keyFile);
  return true;
}

/**
 * **一直在等**（后台跑，不挡服务启动）。
 *
 * ⚠️ 为什么要它，而不是"开机领一次、领不到就算了"：
 *    容器要**一直跑着**（池子那个形状），而用户可能**几分钟后**才在网页上填 key。
 *    只领一次的话，那台容器就永远不会有凭据，直到有人手动重启它。
 * ⇒ 领到了就写文件、然后停下；没领到就过一会儿再来。
 * ⚠️ 它是**后台**的：**不许挡住服务启动**（界面要照常起来）。
 *
 * @returns {{stop: () => void}}
 */
export function watchForKey({
  socketPath,
  keyFile = adoptKeyFile(),
  attemptMs = 60_000,
  idleMs = 5_000,
  log = (m) => console.log(m),
} = {}) {  // 🔴 **归一必须写在函数体里，不能只写在默认值里**（2026-09-21 真机栽的第三层）：
  //    默认值**只在参数是 `undefined` 时**才生效，而镜像里那个**旧入口**是
  //    **显式**传 `keyFile: '/run/hupo/creds.yaml'`（tmpfs）进来的 ⇒ 默认值被绕过，
  //    钥匙照样写进 tmpfs（现象：容器日志说"拿到凭据了"，而**卷里没有那个文件**）。
  keyFile = adoptKeyFile(keyFile);
  let stopped = false;
  let timer = null;
  /**
   * **"还没等到 key"那句话说过没有**（2026-09-23 修，账 #54）。
   *
   * ⚠️ 为什么要有它：这一圈是**一直守着**的（下面那条注释解释了为什么不能领一次就走），
   *    而**用户几天不填钥匙**时，原来**每一圈都念一遍同一句话** ⇒
   *    容器日志（和宿主日志）每 60 秒长两行，把真错误淹掉。
   *    ⇒ 现在**那句话只说第一次**：没等到就是没等到，重复说不提供任何新信息；
   *      真变了（钥匙到了 / 钥匙坏了）本来就有各自的那一句。
   */
  let toldWaiting = false;

  const once = async () => {
    if (stopped) return;
    const ok = await fetchKeyFromHost({
      socketPath,
      keyFile,
      waitMs: attemptMs,
      hardMs: attemptMs + 10_000,
      logWaiting: !toldWaiting,
      log,
    });
    if (stopped) return;
    if (ok) {
      toldWaiting = false; // 钥匙到了 ⇒ 下一次"没等到"又是一条新消息（他可能又换一把）
      // 🔴 **领到了也要接着守**（2026-09-21 实测栽了一次）。
      //
      //    原来这里是 `return`（"不再等了"）—— 于是**只有第一把钥匙能送到**：
      //    · 那把钥匙**不灵**、用户要重填 ⇒ 第二把**没人接**（宿主推了个空），
      //      而宿主那本账已经是"有钥匙" ⇒ 用户看着有钥匙、模型那条路其实不通；
      //    · 用户在别处换了一把 ⇒ 同样送不进来。
      //    ⇒ 改成**一直守着**：每送到一把就隔一会儿重连一次，继续等下一把。
      //    ⚠️ 重连这一下也顺手把"宿主新推的那把"补回来：
      //      新连接一连上就发 `need-key`，宿主手上有的会**立刻回给它**
      //      （所以中间那几秒的空窗也不会把钥匙弄丢）。
      log('  ✓ 凭据就位 —— 继续守着（他可能换一把，那一把也可能不灵）');
      timer = setTimeout(once, idleMs);
      timer.unref?.();
      return;
    }
    // 没领到：过一会儿再来（宿主的通道可能还没起来 / 用户还没填）
    toldWaiting = true; // 这一圈已经说过了 ⇒ 下一圈不再重复同一句（见上面那条）
    timer = setTimeout(once, idleMs);
    timer.unref?.();
  };

  timer = setTimeout(once, 0);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * 连回宿主领配置。
 *
 * @param {object} o
 * @param {string} o.socketPath  宿主给这一台挂进来的那个套接字
 * @param {string} o.keyFile     写到哪（容器里的 tmpfs）
 * @param {number} [o.waitMs]    "还没有 key"时最多等多久
 * @param {number} [o.retryMs]
 * @param {number} [o.hardMs]    🔴 **总时限**（默认 `waitMs + 30s`）：到点**一定**收场
 * @param {(m:string)=>void} [o.log]  ⚠️ **只许传不敏感的东西**
 * @returns {Promise<boolean>}     `true` = key 已经就位
 */
export function fetchKeyFromHost({
  socketPath,
  keyFile = adoptKeyFile(),
  waitMs = 120_000,
  retryMs = 3_000,
  hardMs = null,
  logWaiting = true,
  log = (m) => console.log(m),
} = {}) {
  keyFile = adoptKeyFile(keyFile); // ⚠️ 同上：显式传进来的坏值也要在这里被纠正
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    let waited = 0;
    let timer = null;
    /**
     * 🔴 **总时限**：不管对面说什么、也不管它说不说话，到点**一定**收场。
     *
     * ⚠️ 为什么要它（2026-09-21 **变异验证抓出来的**）：把 `waiting` 那个分支去掉之后，
     *    这个 promise **永远不 resolve** —— 于是容器**永远停在"等配置"那一步**，
     *    界面永远起不来。**"因为一句不认识的话而永远挂着"** 比"如实说不通"坏得多。
     *    ⇒ 两条一起加：**未知状态照实收场** + **总时限兜底**。
     */
    const hard = setTimeout(() => {
      log('  · 等配置超时了 —— 先把服务起起来（模型那条路会如实说不通）');
      finish(false);
    }, hardMs ?? waitMs + 30_000);
    hard.unref?.();

    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      if (timer) clearTimeout(timer);
      try {
        conn.destroy();
      } catch {
        /* 已经断了 */
      }
      resolve(ok);
    };

    let conn;
    try {
      conn = nodeNet.connect(socketPath);
    } catch {
      // 连不上（路径不在、没挂进来）⇒ **如实说"没领到"，但不抛**
      log('  · 没连上宿主那条通道（这一台先不配模型凭据）');
      return resolve(false);
    }

    conn.setEncoding('utf8');
    conn.on('error', () => {
      // ⚠️ 这里**不打印 socketPath**：它是宿主侧信息，对排障没用，倒是会把内部布局漏到用户看得见的地方
      log('  · 宿主那条通道断了 —— 这一台先不配模型凭据');
      finish(false);
    });
    conn.on('connect', () => {
      conn.write(`${JSON.stringify({ v: 1, type: 'hello', role: 'tenant-shell' })}\n`);
    });
    conn.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // 读不懂就跳过（对面是宿主，但不许因为一行坏话就把自己弄死）
        }
        // ⚠️ 认不出的状态**照实收场**，不许当作"没听见"继续等
        //    （那会让容器永远停在等配置那一步；总时限是第二道兜底）
        if (msg?.state !== 'ready' && msg?.state !== 'waiting' && msg?.state !== 'error') {
          log('  ⚠️ 宿主那条通道说了个认不出的状态 —— 先不配凭据了');
          return finish(false);
        }
        // ★ **一整包优先**（P1-29）：宿主现在会**同时**带 `key`（老盒子认它）与 `creds`（新盒子认它）
        //   ⇒ 认得出 `creds` 就用合并那条路（多几样一起存），认不出就退回"就一把钥匙"。
        const pack = msg?.state === 'ready' && msg.creds && typeof msg.creds === 'object' ? msg.creds : null;
        if (pack && Object.keys(pack).length > 0) {
          try {
            mergeKeyFile(keyFile, pack);
          } catch (err) {
            log(`  ⚠️ 凭据写不进去：${err?.message ?? err}`);
            conn.write(`${JSON.stringify({ v: 1, type: 'error', why: 'key-write-failed' })}\n`);
            return finish(false);
          }
          log(`  ✓ 拿到凭据了（${Object.keys(pack).length} 样：放在它该在的地方）`);
          conn.write(`${JSON.stringify({ v: 1, type: 'ready' })}\n`);
          return finish(true);
        }
        if (msg?.state === 'ready' && typeof msg.key === 'string' && msg.key.length > 0) {
          try {
            writeKeyFile(keyFile, msg.key);
          } catch (err) {
            log(`  ⚠️ 凭据写不进去：${err?.message ?? err}`);
            conn.write(`${JSON.stringify({ v: 1, type: 'error', why: 'key-write-failed' })}\n`);
            return finish(false);
          }
          log('  ✓ 拿到模型凭据了（放在它该在的地方）');
          conn.write(`${JSON.stringify({ v: 1, type: 'ready' })}\n`);
          return finish(true);
        }
        if (msg?.state === 'waiting') {
          // 宿主说"还没有" ⇒ 等一会儿再要一次（用户可能正在网页上填）
          if (waited >= waitMs) {
            // ⚠️ **原来的话是假的**（2026-09-21 修）：它写"先把服务起起来"，
            //    可真原因是**用户还没在网页上填钥匙**（宿主服务一直活着）。
            //    一句指错方向的话，比不说更费时间 —— 这个项目里已经栽过好几次。
            // ⚠️ `logWaiting === false` ⇒ **这一圈不重复说**（账 #54：一直守着的那个
            //    循环里，同一句话每 60 秒念一遍会把真错误淹掉；由调用方决定说几次）。
            if (logWaiting) {
              log('  · 还没等到 key —— 用户还没在网页上填（填了会自动送到，不用重启这一台）');
            }
            return finish(false);
          }
          timer = setTimeout(() => {
            waited += retryMs;
            try {
              conn.write(`${JSON.stringify({ v: 1, type: 'need-key' })}\n`);
            } catch {
              finish(false);
            }
          }, retryMs);
          return;
        }
        if (msg?.state === 'error') {
          // ⚠️ 协议层面的错（版本不对那种）——**照实说**，别自己猜
          log(`  ⚠️ 宿主那条通道说了句听不懂的：${String(msg.why ?? '').slice(0, 80)}`);
          return finish(false);
        }
      }
    });
    conn.on('close', () => finish(false));
  });
}
