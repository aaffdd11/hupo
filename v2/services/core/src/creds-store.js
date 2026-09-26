// **那四样凭据存在哪**（主人 2026-09-24 定的配置页 · 契约 `docs/dev/79-CREDS-TABS.md`）。
//
// ── 三种人、三个落点（**别读成一套**）──────────────────────────
//   · **主人**（`kind:'local'`，他这一份就在本机）：
//       语言那一把 ⇒ **DSH 自己那份凭据**里那个 `refs.DEEPSEEK_API_KEY`
//                     （事实：钥匙只住在那儿；`records` 里那条是**浏览器会话授权**，无关）
//       其余三样   ⇒ **我们自己的**按人一份的存档（下面这个）
//   · **租户**：语言那一把走**已有的那条路**（`channel.pushKey` → 他盒子里那卷），
//       其余三样同样进**中心这份按人存档**。
//   · ⚠️ **为什么那三样不塞进盒子那个文件**：盒子那个 `writeKeyFile` 是**整份重写**
//     （只写一行 `HUPO_MODEL_KEY:`）⇒ 下一次送钥匙就把它们抹掉了。
//     要进盒子得改产品层（那是部署期的事，要主人签字）⇒ **今天不进**。
//
// ⚠️ 这份存档**只报"有没有"**，`/api/space` 永远不回值（见 `credStatus`）。
// ⚠️ 文件名里的 `sub` **要洗**：它虽然来自验签令牌，但"拿它拼路径"这件事本身
//    必须自己再挡一道（`../` 那类输入绝不许走到文件系统）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { credStatus, mergeCreds, parseCreds } from './creds.mjs';

/** 这份存档放哪（**一个规则，只住这一处**）。 */
export function credsDir(dataDir) {
  return nodePath.join(dataDir, 'creds');
}

/** 某个人的那一份。**认不出的 `sub` ⇒ `null`**（调用方要如实报错，不许拼出个野路径）。 */
export function credsFileFor(dataDir, sub) {
  if (typeof sub !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sub)) return null;
  return nodePath.join(credsDir(dataDir), `${sub}.yaml`);
}

/**
 * 读某个人的那一份（读不到 / 坏了 ⇒ 空，**不抛**）。
 *
 * @returns {{values: Record<string,string>, status: {model:boolean,voice:boolean,image:boolean,video:boolean}}}
 */
export function readUserCreds(dataDir, sub, fs = nodeFs) {
  const file = credsFileFor(dataDir, sub);
  if (!file) return { values: {}, status: credStatus({}) };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const { values } = parseCreds(text);
  return { values, status: credStatus(values) };
}

/**
 * 把几样写进他那一份。**原子写 ＋ 0600**（先写 `.tmp` 再 `rename`）。
 *
 * ⚠️ 原子写不是为了性能：`/api/space` 会**并发**读它，直接写会让读的人看到半个文件。
 *
 * @param {Record<string,string>} patch 短名 → 值（`''` ⇒ 删掉那一行）
 * @returns {{ok:boolean, why:string, status:object}}
 */
export function writeUserCreds(dataDir, sub, patch, fs = nodeFs) {
  const file = credsFileFor(dataDir, sub);
  if (!file) return { ok: false, why: 'bad-sub', status: credStatus({}) };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const next = mergeCreds(text, patch);
  try {
    fs.mkdirSync(credsDir(dataDir), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, why: `写不进去：${err?.code ?? err?.message ?? err}`, status: credStatus({}) };
  }
  const { values } = parseCreds(next);
  return { ok: true, why: 'saved', status: credStatus(values) };
}

/**
 * ★ **该推进他盒子的那一包**（短名 → 值 · `#174` 2026-09-27）。
 *
 * 🔴 为什么要有它：中心按人存的那几样（**语音三样 / 图片 / 视频**）与"模型那一把"
 *    住的地方**不一样** —— 模型那把**中心不存**（只在宿主内存 `tenantKeys` 里，
 *    落盘的是他盒子自己那份）。所以"该推什么"必须**现合**：
 *    `readUserCreds` 读回中心存的那几样 ＋（手里有就带上）模型那一把。
 *
 * ⚠️ **返回值可能是 `null`**（一样都没有）—— 调用方据此**不要发空推**。
 * ⚠️ **一个字符都不许进日志**（这把包里有密钥；`serve.js` 那边只念"推了几条"）。
 *
 * @param {{dataDir:string, sub:string, model?:string|null, fs?:object}} o
 * @returns {Record<string,string>|null}
 */
export function tenantCredsPack({ dataDir, sub, model = null, fs = nodeFs } = {}) {
  const { values } = readUserCreds(dataDir, sub, fs);
  const pack = { ...values };
  if (typeof model === 'string' && model.length > 0) pack.model = model;
  return Object.keys(pack).length > 0 ? pack : null;
}

/**
 * **这一份凭据从哪读** —— 按人分目录 **或** 盒子那份单文件（P1-29 · 2026-09-24）。
 *
 * ── 为什么要有这条兜底 ──────────────────────────────────────
 *   宿主上：一个人一份（`data/creds/<他>.yaml`）—— 中心要管很多人。
 *   **盒子里**：`/data/creds.yaml` 是**单文件**（那台只有它的主人），
 *   而它的写入者（`tenant-shell.js` 的 `mergeKeyFile`）写的就是这个单文件。
 *   ⇒ 盒子里的识别路（`asr-creds.js`）与画图（`image-use.js`）**必须也认它**，
 *     否则"钥匙推进去了、里面读不到"（那正是 B10 的第二个原因）。
 *
 * ⚠️ **只在 `HUPO_ROLE=tenant` 时才认那份单文件**：宿主上认它没意义，
 *    而且会让一个陈旧的 `data/creds.yaml` 悄悄影响主人自己（那种"看不出原因"的毛病不要）。
 *
 * @returns {{values: Record<string,string>, status: object, from: 'mine'|'box'|'none'}}
 */
export function credsFor({ dataDir, sub, env = {}, fs = nodeFs } = {}) {
  const mine = readUserCreds(dataDir, sub, fs);
  if (Object.keys(mine.values).length > 0) return { ...mine, from: 'mine' };
  if (env.HUPO_ROLE === 'tenant') {
    let text = '';
    try {
      text = fs.readFileSync(nodePath.join(dataDir, 'creds.yaml'), 'utf8');
    } catch {
      text = '';
    }
    const { values } = parseCreds(text);
    if (Object.keys(values).length > 0) return { values, status: credStatus(values), from: 'box' };
  }
  return { ...mine, from: 'none' };
}
