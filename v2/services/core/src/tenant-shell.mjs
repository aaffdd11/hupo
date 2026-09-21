// **容器那一侧的"空壳"**（多租户 ②-4）：开机连回宿主，等自己那份配置。
//
// 这就是主人要的那个形状（`37-MULTITENANT.md` §12.1）：
//
//     ① 容器起来 —— 是个**空壳**（没有 key、没有用户数据）
//     ② 里面那个服务先等（它就是个"配置入口"，还不干正事）
//     ③ 用户在网页上填**自己的** key ⇒ 中心当管道送进那个入口
//     ④ 入口把 key 放到该在的地方（`/run/hupo/creds.yaml`，tmpfs · root 0600）
//     ⑤ 这才启动真正那套服务
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① 🔴 **key 只写进那个文件**，不进日志、不进 env、不回显（本文件里它只以变量形式存在）；
//   ② **等不到就如实返回 `false`**，不许假装成功 —— 上层会照实说"模型那条路不通"，
//      而**界面照常**（用户能看到自己的东西，只是它暂时不会答话）；
//   ③ **不抛**：连不上 / 对面说了听不懂的话 ⇒ 都是 `false`，把"起不来"和"没配置"分开。

import nodeFs from 'node:fs';
import nodeNet from 'node:net';

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
  keyFile,
  waitMs = 120_000,
  retryMs = 3_000,
  hardMs = null,
  log = (m) => console.log(m),
} = {}) {
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
            log('  · 等了很久还是没有 key —— 先把服务起起来（模型那条路会如实说不通）');
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
