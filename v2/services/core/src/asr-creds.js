// **语音那条路用谁的凭据**（P1-26 · 契约 `docs/dev/71-MIC-ASR.md` §四）。
//
// ── 为什么要有这一个模块 ────────────────────────────────────
// `/api/asr` 原来拿的是**开机那一刻**从环境变量里读出来的一份 `config`：
//   · 换一把钥匙 ⇒ **必须重启服务**（而"重启"在这台机器上是主人的动作）；
//   · 也**没有"这是谁在用"这一维** —— 谁连上来都用部署默认那一把。
//
// ⇒ 这里把它变成**按连接现取**：
//   ① `sub`（那一端验过签的身份）**传进来了**，所以"以后要按人取"这件事
//      只差**一处实现**（见下面的 `perUser` 缝）；
//   ② `data/asr.env` **每次现读** ⇒ 主人**轮换密钥之后不用重启**（B5 那条正好要用它）。
//
// ⚠️ **今天还没有"按人一份语音凭据"这种东西**：盒子里那份 `creds.yaml` 装的是**模型钥匙**，
//    而且是**盒子里的服务**在用；宿主看不到、也没有语音字段的形状。
//    ⇒ 那件事（四把钥匙、`VOICE_FIELDS`）**要主人先定 tab 的形状**（`77-BLOCKERS.md` B1/B2）。
//      在那之前这里**明说"只有部署默认这一份"**，绝不假装按人取过了。
//
// ⚠️ **密钥不进日志**：这里只回"有没有、从哪来"，`describe()` 里一个字符都不带。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { asrConfigFromEnv } from './asr.js';
import { VOICE_FIELDS } from './creds.mjs';
import { credsFor } from './creds-store.js';

/** 那三样的名字（**只此一处**：读文件与读环境变量用的是同一组）。 */
export const VOICE_ENV_NAMES = ['TENCENT_APPID', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY'];

/**
 * 语音那三样在**存档里**叫什么（短名）。
 * ⚠️ 这张表只住一处：`creds.mjs` 的 `VOICE_FIELDS`（顺序＝AppID / SecretId / SecretKey）。
 */
const VOICE_FIELD_OF = Object.freeze({
  TENCENT_APPID: VOICE_FIELDS[0],
  TENCENT_SECRET_ID: VOICE_FIELDS[1],
  TENCENT_SECRET_KEY: VOICE_FIELDS[2],
});

/** 默认的钥匙文件（`restart-core.sh` 也读它：**0600、不进仓库**）。 */
export function defaultAsrEnvFile(dataDir) {
  return nodePath.join(dataDir, 'asr.env');
}

/**
 * 把 `KEY=VALUE` 那种文件读成对象（**纯函数**，好判）。
 *
 * ⚠️ 不 `source` 它：那要起一个 shell，而这个文件里可能写着任何东西。
 *    只认"一行一个 `名字=值`"：空行与 `#` 注释跳过；名字不认识就跳过（**不是错**，
 *    主人可能在里面留别的变量）；值两边的引号脱掉（`asr.env` 是手写的）。
 *
 * @returns {Record<string,string>}
 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/**
 * 现读一次"这台部署默认那一份"语音凭据。
 *
 * `env` 优先于文件（与 `restart-core.sh` 的行为一致：它 `source` 文件之后交给进程），
 * 但**文件优先于"开机时那份 env"** —— 这正是"轮换之后不用重启"的来处：
 * 文件是现读的，进程 env 是开机那一刻的。
 *
 * ⚠️ 读不到文件（没有 / 权限不对 / 是目录）**不是错**，是"这台还没配"——
 *    但**要能看出来是哪种**：`why` 里说一句，日志里也只有这一句（没有内容）。
 *
 * @returns {{appid:string, secretId:string, secretKey:string, engine:string, upstream:string|null,
 *            configured:boolean, source:'file'|'env'|'none', why:string}}
 */
export function resolveVoiceCreds({ dataDir, env = process.env, fs = nodeFs } = {}) {
  const file = defaultAsrEnvFile(dataDir ?? env?.HUPO_DATA ?? process.cwd());
  let fromFile = {};
  let why = '';
  let hadFile = false;
  try {
    if (fs.existsSync(file)) {
      hadFile = true;
      fromFile = parseEnvFile(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    // 读不了 ⇒ 当成没有，但**说得出为什么**（权限、被删…）
    why = `那份钥匙文件读不出来（${err?.code ?? err?.message ?? err}）`;
  }
  const pick = (name) => fromFile[name] || env?.[name] || '';
  const appid = pick('TENCENT_APPID');
  const secretId = pick('TENCENT_SECRET_ID');
  const secretKey = pick('TENCENT_SECRET_KEY');
  const engine = fromFile.TENCENT_ASR_ENGINE || env?.TENCENT_ASR_ENGINE || '';
  const upstream = fromFile.HUPO_ASR_URL || env?.HUPO_ASR_URL || null;
  const hasKey = Boolean(appid && secretId && secretKey);
  const configured = Boolean(upstream) || hasKey;
  const source = hasKey && (fromFile.TENCENT_APPID || fromFile.TENCENT_SECRET_ID || fromFile.TENCENT_SECRET_KEY)
    ? 'file'
    : hasKey ? 'env' : 'none';
  if (!configured && why === '') {
    why = hadFile ? '文件在，但里面没有那三样（或只写了一半）' : '还没有那份钥匙文件';
  }
  // ⚠️ 形状与 `asrConfigFromEnv()` 一致（`asr.js` 直接用）——`engine` 空就让它去兜底。
  const base = asrConfigFromEnv({ ...env, ...(engine ? { TENCENT_ASR_ENGINE: engine } : {}) });
  return { ...base, appid, secretId, secretKey, engine: engine || base.engine, upstream, configured, source, why };
}

/**
 * **按人取凭据**（P1-26 的缝）。
 *
 * 🔴 今天**只有部署默认那一份** —— 因为"按人一份语音凭据"的形状还没定
 *    （主人要拍 B1/B2：配置页那几个 tab 各是什么、`/api/space` 回什么）。
 *    ⇒ 这个函数**只做一件事**：把"将来按人取"的落点摆在这儿，
 *      并且**如实**把 `source` 说成 `'default'`，**不假装是"他自己的"**。
 *
 * @param {object} o
 * @param {string|null} o.sub 这一端验过签的身份（**从令牌来**，绝不从请求里读）
 */
export function voiceCredsFor({ sub = null, dataDir, env = process.env, fs = nodeFs } = {}) {
  const who = typeof sub === 'string' && sub ? sub : null;
  // ★ **他自己的那三样优先**（P1-26 后半 · 2026-09-24）：配置页那一屏填的就是这三样
  //   （`creds-store.js` 的 `data/creds/<他>.yaml`，键名 `HUPO_VOICE_*`）。
  //   ⚠️ **三样齐了才算数**（缺一样就是没填过）—— 与页面回报的口径**同一个规则**
  //      （`creds.mjs` 的 `credStatus`），不然会出现"页面说有、发出去是空的"。
  // ⚠️ 用 `credsFor`（不是 `readUserCreds`）：**盒子里那份是单文件**（P1-29）
  const mine = who ? credsFor({ dataDir, sub: who }).values : {};
  const mineOk = VOICE_ENV_NAMES.every((n) => typeof mine[VOICE_FIELD_OF[n]] === 'string'
    && mine[VOICE_FIELD_OF[n]].length > 0);
  if (mineOk) {
    const engine = mine.engine ?? '';
    const base = asrConfigFromEnv(engine ? { ...env, TENCENT_ASR_ENGINE: engine } : env);
    return {
      ...base,
      appid: mine.voiceAppId,
      secretId: mine.voiceSecretId,
      secretKey: mine.voiceSecretKey,
      upstream: null, // 他自己填的是"直连腾讯"那三样，不走取证中转
      configured: true,
      source: 'his-own',
      sub: who,
    };
  }
  const cfg = resolveVoiceCreds({ dataDir, env, fs });
  // ⚠️ 没有他自己那份 ⇒ 退回**部署默认那一份**（`data/asr.env` 现读）。
  //    来源如实写 `default`，**绝不假装是他的**。
  return { ...cfg, sub: who, source: cfg.configured ? 'default' : 'none' };
}

/**
 * 给日志用的一句话：**有没有、从哪来** —— **绝不含密钥的任何一个字符**。
 *
 * @returns {string}
 */
export function describeVoiceCreds(cfg) {
  if (!cfg?.configured) return `没配语音凭据（${cfg?.why ?? '原因不明'}）`;
  // ⚠️ **连"末四位"都不报**：那是半个秘密。只报**长度** ——
  //    够用来回答"轮换之后读到新的没有"（长度变成 0 就是没读到），
  //    而长度不泄露钥匙本身。
  const len = (s) => (typeof s === 'string' ? s.length : 0);
  return (
    `语音凭据（来源 ${cfg.source ?? 'default'} · 引擎 ${cfg.engine ?? ''}${cfg.upstream ? ' · 走中转' : ''}）`
    + `：APPID ${len(cfg.appid)} 位 · SECRET_ID ${len(cfg.secretId)} 位 · SECRET_KEY ${len(cfg.secretKey)} 位`
  );
}
