// 本地通道（域套接字）**交给谁** —— 这条规则只住在这里。
//
// 🔴 为什么有它（2026-09-24 真机抓到的，主人的 u2 号报"小程序放不上去"）：
//
//   盒子（租户容器）里的**服务是 root 起的**（`/app/entry.mjs`，uid 2002=hupo-b），
//   而干活的**agent 是 uid 1000**（`/bin/dsh --profile sdk …`，宿主上看到 297607）。
//   那两条本地通道照老样子按"进程自己的 uid + 0600"建出来 ⇒ 属主 root
//   ⇒ **agent 连不上（EACCES）**。真机上以 uid 1000 复现过，两条都连不上：
//
//       /data/apps.sock   → EACCES connect EACCES /data/apps.sock
//       /data/ledger.sock → EACCES connect EACCES /data/ledger.sock
//
//   ⇒ 盒子里"在对话里造小程序"和"记账"两条路**从来没通过**；
//     主人自己那一格看不出来，因为那边服务与 agent 是**同一个 uid**，
//     0600 同 uid 自然通。**这是一条只有租户才犯的病**（闸全绿也照样犯）。
//
// ⚠️ **准入不许放宽**：仍然是 **0600**（只有那一个 uid 能连），
//    要改的只是**属主**。把 0666 当修法 = 把"谁能连"这条准入直接拆了。
//
// ⚠️ 顺序照 `entry.mjs` 那条实测经验：**先 chmod 再 chown** ——
//    反过来文件已经属于 1000，root 再 chmod 就要 `FOWNER`，
//    而运行时只带四条能力（`.crashpad` 那个坑）。调用方负责先 chmod。
//
// ⚠️ 宿主（本机服务）**什么都不做**：那里没这两个 env，agent 与服务同 uid。

import * as nodeFs from 'node:fs';

/**
 * 盒子里那个 agent 的 uid/gid。
 *
 * ⚠️ 宿主进程没有这两条 env ⇒ 返回 `null`（宿主上这条规则**不生效**，也不该生效）。
 * ⚠️ `0` 不算"交给谁" —— 那是"没配"，不能拿去 chown。
 *
 * @returns {{uid:number, gid:number}|null}
 */
export function agentOwnerFromEnv(env = process.env) {
  const uid = Number.parseInt(env?.HUPO_AGENT_UID ?? '', 10);
  const gid = Number.parseInt(env?.HUPO_AGENT_GID ?? '', 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  if (uid <= 0 || gid < 0) return null;
  return { uid, gid };
}

/**
 * 该不该动手：**配了** + **我们是 root**（不是 root 就交不出去）。
 *
 * @returns {{hand:boolean, owner:{uid:number,gid:number}|null, why:string}}
 */
export function shouldHandToAgent({ env = process.env, uid = process.getuid?.() } = {}) {
  const owner = agentOwnerFromEnv(env);
  if (!owner) return { hand: false, owner: null, why: '没配 HUPO_AGENT_UID/HUPO_AGENT_GID（宿主上本该如此）' };
  if (uid !== 0) return { hand: false, owner, why: `不是 root（uid=${String(uid)}）` };
  if (uid === owner.uid) return { hand: false, owner, why: '本来就是他的' };
  return { hand: true, owner, why: '盒子里：交给干活的那个 uid' };
}

/**
 * 把刚听上的套接字交给 agent（盒子里必须做，宿主上是空操作）。
 *
 * @returns {{done:boolean, why:string}}
 */
export function handSocketToAgent(path, {
  env = process.env,
  uid = process.getuid?.(),
  fs = nodeFs,
  log = () => {},
} = {}) {
  const d = shouldHandToAgent({ env, uid });
  if (!d.hand) return { done: false, why: d.why };
  try {
    fs.chownSync(path, d.owner.uid, d.owner.gid);
    return { done: true, why: `已交给 ${d.owner.uid}:${d.owner.gid}` };
  } catch (err) {
    // ⚠️ **不抛**：服务不该因为这一下起不来。但也**不许悄悄过** ——
    //    它起不来的表现就是盒子那头一句 EACCES（正是这次的事故形状）。
    log(`套接字没能交给 agent(${d.owner.uid})：${err?.message ?? err} ⇒ 盒子里它会连不上（EACCES）`);
    return { done: false, why: err?.code ?? 'chown 失败' };
  }
}
