// **本机投递一把钥匙**（契约 `docs/dev/46-KEY-DELIVERY.md` §三.2）。
//
// 主人 2026-09-22 要的第三个入口：*"还要能从外面投进去（不动 root）"*。
// ⇒ 往一个**只有 `deploy` 写得进去**的目录里放 `<谁>.key`，宿主替他送进那台容器。
//
// ── 为什么它不新增任何能力 ────────────────────────────────
//   能写那个目录的人**就是 `deploy`**（主人），而他本来就能跑 `scripts/…`、
//   本来就能 `podman exec`。⇒ 这条路的价值是**顺手**，不是"多一个口子"。
//
// ── 三条纪律 ──────────────────────────────────────────────
//   ① 🔴 **送到才删**：文件要留到那一台**自报"我有钥匙了"**才删。
//      中心内存里那份**不落盘** ⇒ "读到就删"会在宿主重启时**把没送到的那把弄丢**。
//   ② 🔴 **认不出就留证据**（挪进 `.rejected/` 并说清为什么）—— **不许静默删掉**：
//      那里面可能是一把真钥匙。
//   ③ 🔴 **钥匙永远不进日志、不进账本**：日志里只有"谁、投给哪台、送到没有"。

import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

/** 默认投递目录（`deploy` 自己的家目录里，`0700`）。 */
export const DEFAULT_DROP_DIR = nodePath.join(nodeOs.homedir(), '.hupo-keys');

/** 只认这个后缀 —— 一眼能看出"这是个要投的东西"，也不会误伤别的文件。 */
export const DROP_SUFFIX = '.key';

/** 认不出的挪到这里（**留证据**，不删）。 */
export const REJECT_DIR = '.rejected';

/** 一把钥匙最长允许多少字节（防有人误投一个几百 MB 的文件进来）。 */
export const MAX_KEY_BYTES = 4096;

/** 每次扫的间隔。它只在"主人刚投了一把"时有意义，所以不用密。 */
export const DROP_POLL_MS = 5000;

/**
 * 等不到回执时**再送一次**的间隔。
 *
 * 🔴 为什么非有不可（2026-09-21 真机当场栽的）：推送可能**根本没落地** ——
 *    那一台正好在重连、或者**刚被重建**（tmpfs 里的东西没了），
 *    而"送过就算数"的写法会把它记成"已推送"，然后**永远等下去**：
 *    文件不删、钥匙不进容器、谁都不报错。⇒ 有界重试，直到它**自己说拿到了**。
 */
export const DROP_REPUSH_MS = 30_000;

/**
 * 把文件名认成"给谁"的。**纯函数**（`test/unit` 里逐条钉）。
 *
 * 认三种名字：**租户名**（`hupo-a.key`）· **编号**（`u1.key`）· **手机号**（`13800000000.key`）。
 *
 * ⚠️ **凡是认不出的一律 `ok:false` 并给一个具体理由** —— 调用方据此把文件挪走并说清，
 *    而不是"没看懂就跳过"（那样主人的钥匙会静静地躺在那儿，谁也不知道）。
 *
 * @param {string} name  文件名（只要 basename）
 * @param {object} o
 * @param {string[]} o.tenantNames            这台机器上真实存在的那几台
 * @param {(t:string)=>(string|null)} o.userIdOfTenant
 * @param {(u:string)=>(string|null)} o.tenantOfUser
 * @param {(p:string)=>(string|null)} o.userIdOfPhone
 * @returns {{ok:true, how:'tenant'|'user'|'phone', userId:string, tenant:string}
 *          |{ok:false, why:string}}
 */
export function resolveDropName(name, { tenantNames = [], userIdOfTenant, tenantOfUser, userIdOfPhone } = {}) {
  const base = String(name ?? '');
  // 只认**光名字**：带路径、带反斜杠、以点开头（含 `.`/`..`/隐藏文件）一律拒
  if (!base || base !== nodePath.basename(base) || base.startsWith('.')) {
    return { ok: false, why: '文件名不对（只能是 <谁>.key，不许带路径）' };
  }
  if (!base.endsWith(DROP_SUFFIX)) {
    return { ok: false, why: `没有 ${DROP_SUFFIX} 后缀（我不认别的文件）` };
  }
  const stem = base.slice(0, -DROP_SUFFIX.length);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(stem)) {
    return { ok: false, why: '名字里有不认识的字符' };
  }
  // ① 租户名（`hupo-a`）
  if (tenantNames.includes(stem)) {
    const userId = userIdOfTenant?.(stem) ?? null;
    if (!userId) return { ok: false, why: `${stem} 这台没登记在谁名下` };
    return { ok: true, how: 'tenant', userId, tenant: stem };
  }
  // ② 编号（`u1` / `t3`）
  const tenantFromUser = tenantOfUser?.(stem) ?? null;
  if (tenantFromUser) return { ok: true, how: 'user', userId: stem, tenant: tenantFromUser };
  // ③ 手机号（**只有它真的登记过**才算 —— 不许凭"像手机号"就建一个新号）
  if (/^[0-9]{6,20}$/.test(stem)) {
    const userId = userIdOfPhone?.(stem) ?? null;
    if (userId) {
      const tenant = tenantOfUser?.(userId) ?? null;
      if (tenant) return { ok: true, how: 'phone', userId, tenant };
    }
    return { ok: false, why: '这个手机号还没登记过（先让他登录一次，再投）' };
  }
  return { ok: false, why: '认不出这是谁（用租户名 / 编号 / 登记过的手机号）' };
}

/**
 * 钥匙文本够不够格。**纯函数**。和网页那条路**同一条规矩**
 * （能被 HTTP 头带走的字符）。
 */
export function checkKeyText(raw) {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length === 0) return { ok: false, why: '空的' };
  if (/[^\x20-\x7e]/.test(key)) return { ok: false, why: '有不可打印的字符（多半是粘错了）' };
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) return { ok: false, why: '太长了，不像一把钥匙' };
  return { ok: true, key };
}

/**
 * 投递看守（**宿主这一侧**）。
 *
 * ⚠️ 它**不自己送** —— "怎么送进容器"由调用方给（`deliver`），因为那件事只有
 *    `serve.js` 手上那套通道知道（`setModelKey`）。
 *    ⇒ 这一份只负责：**认名字、读文件、催、等回执、删或挪**。
 *
 * @param {object} o
 * @param {string} [o.dir]
 * @param {(userId:string, key:string)=>{ok:boolean, why?:string, pushed?:number}} o.deliver
 * @param {(name:string)=>{ok:true,userId:string,tenant:string}|{ok:false,why:string}} o.resolve
 * @param {(m:string)=>void} [o.log]
 * @param {import('node:fs')} [o.fs]
 * @param {number} [o.pollMs]
 */
export function createKeyDrop({
  dir = DEFAULT_DROP_DIR,
  deliver,
  resolve,
  log = () => {},
  fs = nodeFs,
  pollMs = DROP_POLL_MS,
  repushMs = DROP_REPUSH_MS,
} = {}) {
  /** 已经催过、正在等那台回执的（path → {userId, since}） */
  const waiting = new Map();
  let timer = null;

  const ensureDir = () => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(nodePath.join(dir, REJECT_DIR), { recursive: true, mode: 0o700 });
    } catch {
      /* 建不了就下一拍再说（**不许把服务带走**） */
    }
  };

  const reject = (name, why) => {
    const from = nodePath.join(dir, name);
    const to = nodePath.join(dir, REJECT_DIR, name);
    try {
      fs.renameSync(from, to);
      log(`  ⚠️ 投递的「${name}」认不出：${why} ⇒ 原样挪到 ${REJECT_DIR}/（**没删**）`);
    } catch (err) {
      log(`  ⚠️ 投递的「${name}」认不出（${why}），而且挪不动：${err?.message ?? err}`);
    }
  };

  const tick = (now = Date.now()) => {
    ensureDir();
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
    } catch {
      return; // 目录不在（还没建起来）—— 下一拍再说
    }
    for (const name of names) {
      const full = nodePath.join(dir, name);
      // 只处理**普通文件**（目录/套接字一律不碰）
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      const who = resolve(name);
      if (!who.ok) {
        reject(name, who.why);
        continue;
      }

      let text = '';
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch (err) {
        log(`  ⚠️ 投给 ${who.tenant} 的那个文件读不出来：${err?.code ?? err}`);
        continue;
      }
      const good = checkKeyText(text);
      if (!good.ok) {
        reject(name, `里面的东西不像一把钥匙（${good.why}）`);
        continue;
      }

      // 已经催过、在等回执的：**到点再催一次**（原因见 `DROP_REPUSH_MS`），
      // 没到点就安静等着（每次扫都催是刷屏，不是本事）。
      const w = waiting.get(full);
      if (w) {
        if (w.userId !== who.userId) {
          waiting.delete(full); // 换了主人（主人把文件改投别人了）⇒ 重新来一遍
        } else if (now - w.pushedAt < repushMs) {
          continue;
        } else {
          const again = deliver(who.userId, good.key);
          if (again?.ok) {
            w.pushedAt = now;
            w.tries += 1;
            log(`  · 投给 ${who.tenant} 的那把还没等到回执 ⇒ 又送了一次（第 ${w.tries} 次）`);
          }
          continue;
        }
      }


      const r = deliver(who.userId, good.key);
      if (r?.ok) {
        waiting.set(full, { userId: who.userId, since: now, pushedAt: now, tries: 1 });
        log(`  🔑 有人投了一把钥匙给 ${who.tenant}（${who.how}）—— 正等它自己说收到了`);
      } else {
        log(`  ⚠️ 投给 ${who.tenant} 的那把**还没送出去**（${r?.why ?? '那一台现在不通'}）—— 文件留着，我接着试`);
      }
    }
  };

  return {
    start() {
      ensureDir();
      timer = setInterval(tick, pollMs);
      timer.unref?.();
      return this;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 那台**自己说"我有钥匙了"** ⇒ 才把文件删掉（契约 §三.2 那条纪律）。 */
    confirmed(userId) {
      let n = 0;
      for (const [path, w] of [...waiting.entries()]) {
        if (w.userId !== userId) continue;
        try {
          fs.unlinkSync(path);
          n += 1;
          log(`  ✓ ${userId} 那台说它拿到钥匙了 ⇒ 把投递的那个文件删掉（**没留副本**）`);
        } catch {
          /* 删不掉就下一拍再说 */
        }
        waiting.delete(path);
      }
      return n;
    },
    /** 只看一眼（判据/排障用）。 */
    get pending() {
      return new Map(waiting);
    },
    tick,
    /** 只看一眼"还在等谁的回执"（排障用；**不含钥匙**）。 */
    get waitingFor() {
      return [...waiting.entries()].map(([p, w]) => ({ file: nodePath.basename(p), userId: w.userId, tries: w.tries }));
    },
  };
}
