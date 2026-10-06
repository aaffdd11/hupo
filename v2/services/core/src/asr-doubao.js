// ★ **豆包（火山引擎）大模型流式语音识别** —— 上游那一侧（主人 2026-10-01 定）。
//
// 主人原话：*「帮我把语音，图像，视频，全部用豆包大模型来配置。也就是语音识别，用豆包，
// 图片生成用seedrean，视频用seedance。」* ⇒ 他当场选了「**完全换成豆包**」（腾讯那三样撤掉）。
//
// ── 这一份是什么 ──────────────────────────────────────────
//   `asr.js` 那条口**面向浏览器的那一套协议一个字不改**（二进制＝16k 单声道 PCM、
//   文本帧 `asr/start`/`asr/stop`；回 `asr/ready`/`partial`/`final`/`end`/`capped`/`error`/
//   `unavailable`）。变的只有**上游那一跳**：从"腾讯的 JSON 协议"换成"豆包的二进制帧"。
//   ⇒ 客户端一个字节都不用改。
//
// ── 协议（照官方那页抄下来的，`docs.volcengine.com/docs/6561/1354869`）──────
//   端点：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`（双向流式）
//   建连头：`X-Api-App-Key`(App ID) · `X-Api-Access-Key`(Access Token) ·
//           `X-Api-Resource-Id`(资源，如 `volc.bigasr.sauc.duration`) · `X-Api-Connect-Id`(UUID)
//   帧：**4 字节 header ＋ [4 字节 sequence（可选）] ＋ 4 字节 payload size（大端） ＋ payload**
//     · header[0] = 0x11（version 1 ＋ header size 4×1）
//     · header[1] = (message type << 4) | flags
//         消息类型：0b0001 = full client request（带请求参数）· 0b0010 = audio only
//                   0b1001 = full server response · 0b1111 = 错误
//         flags：0b0000 = 没有 sequence · 0b0001 = 有（正）· 0b0010 = 最后一包（无 sequence）
//                0b0011 = 有 sequence 且为负（最后一包）
//     · header[2] = (序列化 << 4) | 压缩；序列化 0b0001 = JSON；压缩 0b0001 = gzip
//   音频：**pcm_s16le / 16k / 单声道**，一包 100–200ms（16k×2×0.2 ≈ 6400 字节）
//
// ⚠️ **不许猜的地方**：资源 id 与端点**都能配**（`DOUBAO_ASR_URL` / `DOUBAO_ASR_RESOURCE`）；
//    错误帧有两种形状（"错误码 ＋ 大小 ＋ 正文"与"错误码 ＋ JSON"），解码器**两种都认**，
//    认不出就如实说认不出。
// 🔴 **密钥不进日志、不进回话**：这里只回"有没有配"；出错时只留一句人话。

import nodeCrypto from 'node:crypto';
import * as nodeZlib from 'node:zlib';
import WebSocket from 'ws';

/** 默认端点（**可覆盖**：`DOUBAO_ASR_URL`）。 */
export const DOUBAO_ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

/** 默认资源 id（**可覆盖**：`DOUBAO_ASR_RESOURCE`）。1.0 小时版；2.0 是 `volc.seedasr.sauc.duration`。 */
export const DEFAULT_RESOURCE_ID = 'volc.bigasr.sauc.duration';

/** 模型名（正文里那个 `model_name`；官方目前只有 `bigmodel`）。 */
export const DEFAULT_MODEL_NAME = 'bigmodel';

/** 一包音频建议多大（字节）：100–200ms 的 16k 单声道 s16le。 */
export const AUDIO_CHUNK_BYTES = 3200;

/**
 * ★ 2026-10-07（主人：*「我的目的是语音输入。要连贯」*）：**发完"最后一包"之后，
 * 等多久才算上游把最后那些字吐完了**。
 *
 * 🔴 真机读数（那天的探针）：按停之后**回来的第一帧只有「我们」**，
 *    而原来"第一帧 = 吐完了"⇒ 那一份"整段"就停在「我们」上
 *    （屏幕上原本对的字被这条更短的整段顶掉 —— 主人说的"前面的话被清除"）。
 * ⇒ 改成**安静下来才算吐完**：每来一帧把静音钟往后推一格；
 *    再从"最后一包"起算一个上限（引擎一直吐也得收场，别把用户挂在那儿）。
 */
export const FLUSH_QUIET_MS = 400;
/** 收尾最多等多久（从"最后一包"算起）。 */
export const FLUSH_MAX_MS = 2_500;

/**
 * 凭据从**环境变量**读（与老那套同一个纪律：`data/asr.env` 由 systemd 喂进来）。
 *
 * ⚠️ 三个名字：`DOUBAO_ASR_APPID` · `DOUBAO_ASR_TOKEN` ·（可选）`DOUBAO_ASR_RESOURCE`。
 *    ⚠️ 老那三个 `TENCENT_*` **不再读**（`甲`：完全换成豆包）。
 */
export function doubaoConfigFromEnv(env = process.env) {
  // ★ **新版控制台：一把 API Key**（官方文档 `X-Api-Key`，控制台 >「API Key 管理」）。
  const apiKey = String(env.DOUBAO_ASR_API_KEY ?? '').trim();
  // ⚠️ 旧版那两样（App ID ＋ Access Token）**照旧认** —— 老账号还在用。
  const appid = String(env.DOUBAO_ASR_APPID ?? '').trim();
  const token = String(env.DOUBAO_ASR_TOKEN ?? '').trim();
  const resource = String(env.DOUBAO_ASR_RESOURCE ?? '').trim() || DEFAULT_RESOURCE_ID;
  const url = String(env.DOUBAO_ASR_URL ?? '').trim() || DOUBAO_ASR_URL;
  // `HUPO_ASR_URL` 是**换上游**用的（自托管 / 取证用的桩）：给了它就直接连它
  // —— 让"整条链"能在**没有豆包钥匙**的情况下被真验一遍（判据打在客户端那一侧）。
  const upstream = String(env.HUPO_ASR_URL ?? '').trim() || null;
  const hasKey = Boolean(apiKey) || Boolean(appid && token);
  return { apiKey, appid, token, resource, url, upstream, configured: Boolean(upstream) || hasKey };
}

/**
 * 建连头（**钥匙只在这一处进请求**）。
 *
 * ★ **两套鉴权**（火山官方两版控制台都支持）：
 *   · **新版**（给了 `apiKey`）⇒ `X-Api-Key` ＋ `X-Api-Resource-Id` ＋ `X-Api-Request-Id`
 *     （官方文档「实时语音识别」的请求头；控制台 >「API Key 管理」拿那一把）
 *   · **旧版**（只有 App ID ＋ Access Token）⇒ `X-Api-App-Key` ＋ `X-Api-Access-Key`
 *     ＋ `X-Api-Resource-Id` ＋ `X-Api-Connect-Id`
 * ⚠️ **新版优先**（有 `apiKey` 就不发旧版那两个头）。
 */
export function doubaoHeaders({ apiKey = '', appid = '', token = '', resource, connectId, requestId = null }) {
  const resourceId = String(resource || DEFAULT_RESOURCE_ID);
  const uuid = String(connectId);
  if (String(apiKey).trim() !== '') {
    return {
      'X-Api-Key': String(apiKey).trim(),
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': String(requestId ?? uuid),
    };
  }
  return {
    'X-Api-App-Key': String(appid),
    'X-Api-Access-Key': String(token),
    'X-Api-Resource-Id': resourceId,
    'X-Api-Connect-Id': uuid,
  };
}

/** 每次连接一个新 UUID（官方要求；**它只用来排错**）。 */
export const newConnectId = () => nodeCrypto.randomUUID();

/** 4 字节大端写长度。 */
function writeU32(buf, v, off) {
  buf.writeUInt32BE(v >>> 0, off);
}

/**
 * **full client request**（第一条：请求参数）。
 *
 * ⚠️ 正文用 gzip（header[2] 的低四位 = 0b0001），与官方示例一致；
 *    调用方也能关掉（判据里要能造出"没压缩"的那一份）。
 */
export function encodeFullClientRequest(obj, { gzip = true, zlib = nodeZlib } = {}) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const payload = gzip ? zlib.gzipSync(json) : json;
  const header = Buffer.from([0x11, 0x10, gzip ? 0x11 : 0x10, 0x00]);
  const size = Buffer.alloc(4);
  writeU32(size, payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

/**
 * **audio only request**（后面每一包音频）。
 *
 * @param {Buffer} pcm 16k 单声道 s16le 的字节
 * @param {{last?:boolean}} [o] `last` ⇒ 用 flags 0b0010（"这是最后一包"）
 */
export function encodeAudioFrame(pcm, { last = false } = {}) {
  const body = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? []);
  const header = Buffer.from([0x11, last ? 0x22 : 0x20, 0x00, 0x00]);
  const size = Buffer.alloc(4);
  writeU32(size, body.length, 0);
  return Buffer.concat([header, size, body]);
}

/**
 * **解一帧上游来的东西**。**纯函数**（判据直接喂字节）。
 *
 * @returns {{kind:'result', text:string, definite:string|null, index:number, logid:string|null}
 *          | {kind:'error', code:number, message:string}
 *          | {kind:'unknown', why:string}}
 */
export function decodeServerFrame(raw, { zlib = nodeZlib } = {}) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? []);
  if (buf.length < 4) return { kind: 'unknown', why: 'too-short' };
  const headerSize = (buf[0] & 0x0f) * 4;
  if (headerSize < 4 || buf.length < headerSize) return { kind: 'unknown', why: 'bad-header-size' };
  const type = (buf[1] >> 4) & 0x0f;
  const flags = buf[1] & 0x0f;
  const comp = buf[2] & 0x0f;
  let off = headerSize;
  if (flags & 0x01) off += 4; // 有 sequence
  // ── 错误帧：两种形状都认（见文件头那段）──────────────────
  if (type === 0b1111) {
    if (buf.length < off + 8) return { kind: 'unknown', why: 'error-frame-truncated' };
    const code = buf.readUInt32BE(off);
    const size = buf.readUInt32BE(off + 4);
    const body = buf.slice(off + 8, off + 8 + size);
    let message = body.toString('utf8');
    try {
      const j = JSON.parse(message);
      message = String(j?.message ?? j?.error ?? message);
    } catch {
      /* 不是 JSON 就把原文当话 */
    }
    return { kind: 'error', code, message: message.slice(0, 200) };
  }
  // ── 正常回帧 ─────────────────────────────────────────────
  if (buf.length < off + 4) return { kind: 'unknown', why: 'no-payload-size' };
  const size = buf.readUInt32BE(off);
  off += 4;
  const body = buf.slice(off, off + size);
  let text = body;
  if (comp === 0b0001) {
    try {
      text = zlib.gunzipSync(body);
    } catch {
      return { kind: 'unknown', why: 'gunzip' };
    }
  }
  let j = null;
  try {
    j = JSON.parse(text.toString('utf8'));
  } catch {
    return { kind: 'unknown', why: 'not-json' };
  }
  const result = j?.result ?? {};
  const utts = Array.isArray(result.utterances) ? result.utterances : [];
  // 最后一个"确定句"（`definite: true`）——它就是"这一段说完了"
  let definite = null;
  let index = 0;
  for (let i = 0; i < utts.length; i += 1) {
    if (utts[i]?.definite === true && typeof utts[i]?.text === 'string') {
      definite = utts[i].text;
      index = i;
    }
  }
  return {
    kind: 'result',
    text: typeof result.text === 'string' ? result.text : '',
    definite,
    index,
    logid: typeof j?.logid === 'string' ? j.logid : null,
    // ★ 2026-10-06：**这段回话里的"当前那一句"原样带出来**（形状见 `createSegmentTracker`）。
    //   🔴 真读数告诉我们的：`result.text` 与 `utterances` **只管当前这一句** ——
    //      说第二句时第一句就不在里面了（不是累积）。所以"接成整段"那件事
    //      不能靠这里，得靠 `createSegmentTracker`（它认 `start_time`）。
    utterances: utts.map((u) => ({
      text: typeof u?.text === 'string' ? u.text : '',
      definite: u?.definite === true,
      start: Number.isFinite(u?.start_time) ? u.start_time : null,
      end: Number.isFinite(u?.end_time) ? u.end_time : null,
    })),
  };
}

/**
 * **把上游"一段一段"的话接成"他这一整段"**（纯逻辑 · 判据直接喂帧）。
 *
 * 🔴 为什么非要有它（2026-10-06 · **真读数**，不是猜的）：豆包那一套里
 *    `result.text` 与 `result.utterances` **只是"当前这一句"** —— 说第二句时
 *    `result.text` 就变成第二句的字（`utterances` 里也只剩那一条），第一句**不在里面**。
 *    实测（6.6 秒 · 两句 · 中间停顿，真的连豆包）：
 *    ```
 *    result.text=「今天」 utterances=[（在说）「今天」]      ← 第一句
 *    result.text=「我们」 utterances=[（在说）「我们」]      ← 换句 ⇒ 第一句被顶掉了
 *    ```
 *    ⇒ 照原样转发，屏幕上与**发出去**的都只剩后半段 —— 主人 2026-10-06 报的
 *      *"我说的话前半段会被砍掉"* 就是这个（`docs/dev/193-SPEAK-ACCUMULATE.md`）。
 *    ⇒ 我们自己攒：**那一条翻篇了 = 换了一段** ⇒ 把上一段落进 `done`、段号往前推，
 *      `asr/end` 那条要的是 `whole()`（整段），不是最后那一段。
 *
 * 🔴 **怎么算"翻篇了"：看时间那一对 `start_time`/`end_time`，不是看起点变没变**
 *    （2026-10-06 第二遍真读数抓到的）：上游会把**同一句重新划一遍** —— 实测
 *    ```
 *    4522-4602  「我们」        ← 先给一小条
 *    4382-5322  「我们出去」     ← 同一句的修订（起点还**往前挪了**）
 *    ```
 *    ⇒ 照"起点变了就是新句"会把这一句接成「我们我们出去…」（重复一遍）。
 *    ⇒ 规矩：**两段在时间上叠着 = 还是同一句（那是修订）**；
 *      **后一段的起点 ≥ 前一段的终点 = 真换了句**（一句话说完、下一句才开始）。
 *
 * ⚠️ **段号是我们自己发的**，不是上游数组下标（那个每一句都从 0 开始 ⇒ 客户端的
 *    按段替换会**顶掉**前一段，这正是"前半段没了"的第二半原因）。
 * ⚠️ 没有那对时间的上游（别的引擎 / 老形状）⇒ 退回"共同前缀够长就算同一段"。
 *
 * @returns {{push:(frame:object)=>{partial?:{text:string,index:number},final?:{text:string,index:number}},
 *            whole:()=>string}}
 */
export function createSegmentTracker() {
  /** 已经翻篇的段（按顺序接起来就是"整段"）。 */
  const done = [];
  /** 当前这一段到目前为止的字。 */
  let cur = '';
  /** 当前这一段占的那一段音频（上游给的毫秒；没有就是 `null`）。 */
  let curSpan = null;
  /** 刚说定的那一段占的那一段音频 —— 同一段又回一次（收尾那一包之后就是这样）就当回声。 */
  let doneSpan = null;

  /** 上游那一条的 `{start,end}`（缺一个就当没有）。 */
  const spanOf = (u) =>
    u && Number.isFinite(u.start) && Number.isFinite(u.end) ? { start: u.start, end: u.end } : null;
  /** 两段音频**叠着**吗（叠着 = 同一句的修订；紧挨着/隔开 = 换句）。 */
  const overlaps = (a, b) => (a && b ? a.start < b.end && b.start < a.end : false);
  const sameStart = (a, b) => (a && b ? a.start === b.start : false);

  /**
   * **两句话是不是"同一句"**（＝ 同一句在往下长 / 又准了一点）—— **只看字**。
   *
   * 🔴 2026-10-07：**它现在是"换句没换句"的主判据**（原来时间那一对是主判据，
   *    结果上游重新划句时报出叠着的区间，就会把上一句整句覆盖掉 —— 见下面 `fresh` 那段）。
   * ⚠️ 它比 [looksLikeSame] 宽一点点：**一句包含另一句**也算同一句
   *    （"我们出去" → "我们出去走走吧"、"今天天气不错今天天气不错" 那种截短/补全）。
   */
  const sameSentence = (a, b) => {
    if (a === '' || b === '') return true;
    if (a.includes(b) || b.includes(a)) return true;
    // ⚠️ **一小截被换掉**：那是"说错了重来"（真帧里就有 `嗯` → `今天`）——
    //    那一截短到不成句（≤3 个字）而且新的更长 ⇒ 算同一句在改。
    if (a.length <= 3 && b.length > a.length) return true;
    return looksLikeSame(a, b);
  };

  /** 两句话像不像"同一句"（一个字都不许改的前缀关系太严：补个句号、改个标点都算同一句）。 */
  const looksLikeSame = (a, b) => {
    if (a === '' || b === '') return true;
    const m = Math.min(a.length, b.length);
    let n = 0;
    while (n < m && a[n] === b[n]) n += 1;
    // 短的整个是长的开头 ⇒ 一样（"我们出去走走吧" → "我们出去走走吧。"）
    if (n === m) return true;
    return n / m >= 0.5;
  };

  return {
    /** 喂**一帧**上游回话 ⇒ 该往上发的半句 / 定稿（没有就什么都不带）。 */
    push(frame) {
      const list = Array.isArray(frame?.utterances) ? frame.utterances : [];
      const u = list.length > 0 ? list[list.length - 1] : null;
      const raw = u ? u.text : frame?.text;
      const span = spanOf(u);
      const definite = u ? u.definite === true : false;
      const rawText = typeof raw === 'string' ? raw : '';
      // 空帧（还在听、没字）⇒ 什么都不动
      if (rawText === '' && !definite) return {};
      // 🔴 **空字的"定稿"不许把已经听到的擦掉**（收尾那帧有时不带 result）——
      //    它只是把**当前这一句**收住（字用我们手里那份）。
      const text = rawText !== '' ? rawText : cur;
      if (text === '') return {};
      // 刚说定过的那一段又回一次（上游会把最后那一帧再吐一遍，收尾那一包之后也是它）
      // 刚说定过的那一段又回一次（上游会把最后那一帧再吐一遍，收尾那一包之后也是它）——
      // ⚠️ 这里**从严**：**时间上像同一句**（起点一模一样 **或** 区间叠着）**而且
      //    `字`也像同一句**，才算它；不然会把**下一句**误并进上一句（那就丢了一句）。
      // 🔴 **2026-10-07 再收严一处**（主人报 *"说着说着，转文字的早期的那部分内容
      //    在输入框里没了"*）：原来 `sameStart`（起点一模一样）**单凭它就替换** ——
      //    而上游重新划句时，**新的一句也可能报出与上一句一样的起点**，
      //    那时就会把上一段**整段替换掉**（框里那半句当场没了、收尾拼出来的整段也少了它）。
      //    ⇒ 现在**两样都要**：时间像 **而且** 字像。
      if (cur === '' && done.length > 0 && span && doneSpan
        && (sameStart(doneSpan, span) || overlaps(doneSpan, span))
        && sameSentence(done[done.length - 1], text)) {
        // 一模一样 ⇒ 纯回声，丢掉；**又准了一点 ⇒ 换掉那一段**（不许接成两遍）
        if (text === done[done.length - 1]) return {};
        done[done.length - 1] = text;
        doneSpan = span;
        return { final: { text, index: done.length - 1 } };
      }
      // ── 换句了没有？ ────────────────────────────────────────────
      // 🔴 **2026-10-07 改口径**（主人：*"前面的句子还是会被清理。"*）——
      //    原来这里**先看时间**：区间叠着就一律当"同一句的修订"，`cur = text` 直接覆盖。
      //    而上游**重新划句**的时候，**新的一句完全可能报出与上一句叠着的区间**
      //    ⇒ 上一句**从来没进过 `done`**、当场被覆盖掉 ⇒ 客户端收到"段号没变"的
      //      `partial` ⇒ **把那段换掉** ⇒ 框里前半句当场没了（收尾拼出来的整段也少了它）。
      //    ⇒ 现在**字说了算**：字明显不像同一句 ⇒ 就算换句（时间只能"补充说它换了"，
      //      不能反过来把"换句"否掉）。⚠️ 判据 `test/asr-doubao.test.js` D14。
      const same = sameSentence(cur, text);
      const fresh = cur !== '' && (!same || (curSpan && span ? !overlaps(curSpan, span) : false));
      if (fresh) {
        done.push(cur);
        curSpan = null;
      }
      cur = text;
      if (span) curSpan = span;
      const index = done.length;
      const out = { partial: { text: cur, index } };
      if (definite) {
        done.push(cur);
        doneSpan = curSpan;
        out.final = { text: cur, index };
        cur = '';
        curSpan = null;
      }
      return out;
    },
    /** **整段**（前面几段 ＋ 正在长的这一段）—— `asr/end` 要的就是它。 */
    whole() {
      return done.join('') + cur;
    },
  };
}

/**
 * **上游那一跳**：连上豆包，把音频一包包送过去，把回帧翻成我们那四个事件。
 *
 * @param {object} o
 * @param {{appid:string, token:string, resource:string, url:string, upstream:string|null}} o.config
 * @param {()=>string} [o.connectId]
 * @param {(m:string)=>void} [o.log]
 * @param {typeof WebSocket} [o.WebSocketImpl] 判据里换掉它（不联网）
 */
export function createDoubaoUpstream({ config, connectId = newConnectId, log = () => {}, WebSocketImpl = WebSocket } = {}) {
  /** @type {WebSocket|null} */
  let up = null;
  let ready = false;
  let closed = false;
  /** 我们发过"最后一包"了吗（之后第一帧回话 = 它把最后那些字吐完了）。 */
  let finished = false;
  /** `onEnd` 只许报一次。 */
  let ended = false;
  /** 收尾那两个钟（见 `FLUSH_QUIET_MS`／`FLUSH_MAX_MS`）。 */
  let flushQuiet = null;
  let flushCeiling = null;
  /** 收场（只报一次，并把两个钟都停掉）。 */
  const endNow = () => {
    if (flushQuiet !== null) { clearTimeout(flushQuiet); flushQuiet = null; }
    if (flushCeiling !== null) { clearTimeout(flushCeiling); flushCeiling = null; }
    if (ended) return;
    ended = true;
    onEvt.onEnd?.();
  };
  /** 还没握上手时先攒着（音频不能丢：丢一段就是丢一句话的开头）。 */
  const queue = [];
  let onEvt = {};
  /** ★ **把"一段一段"接成"整段"**（这条连接自己那份账，见 `createSegmentTracker`）。 */
  const tracker = createSegmentTracker();

  const send = (buf) => {
    if (!up) return;
    if (up.readyState === WebSocketImpl.OPEN) up.send(buf);
    else if (up.readyState === WebSocketImpl.CONNECTING) queue.push(buf);
  };

  /** 请求参数那一份（照官方那份字段表）。 */
  function clientRequest() {
    return {
      user: { uid: 'hupo' },
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
      request: {
        model_name: DEFAULT_MODEL_NAME,
        enable_itn: true,
        enable_punc: true,
        show_utterances: true,
      },
    };
  }

  return {
    /** 连上。`evt` = `{onReady,onPartial,onFinal,onEnd,onError}`。 */
    open(evt = {}) {
      onEvt = evt;
      const url = config.upstream ?? config.url;
      const headers = config.upstream
        ? {}
        : doubaoHeaders({ apiKey: config.apiKey, appid: config.appid, token: config.token, resource: config.resource, connectId: connectId() });
      try {
        up = new WebSocketImpl(url, { headers });
      } catch (err) {
        onEvt.onError?.({ kind: 'connect', message: String(err?.message ?? err).slice(0, 200) });
        return;
      }
      up.on('open', () => {
        // 第一条：请求参数（full client request）
        send(encodeFullClientRequest(clientRequest()));
        for (const b of queue) {
          try {
            up.send(b);
          } catch {
            /* 已经没了 */
          }
        }
        queue.length = 0;
      });
      up.on('message', (raw) => {
        const ev = decodeServerFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        if (ev.kind === 'error') {
          onEvt.onError?.({ kind: 'engine', code: ev.code, message: ev.message });
          return;
        }
        if (ev.kind !== 'result') {
          log(`豆包 ASR：回了一帧看不懂的东西（${ev.why}）`);
          return;
        }
        // 🔴 **握手那一拍**：上游对"请求参数"那条的回帧 = 它接了（对应老那套的 `code 0`）。
        if (!ready) {
          ready = true;
          onEvt.onReady?.();
        }
        // ★ 2026-10-06：**自己把段接起来**（根因见 `createSegmentTracker` 上面那段）——
        //    上游按"这一句"给字，说下一句时上一句就不在里面了 ⇒ 我们按 `start_time`
        //    认出"换段了"，把前面的攒住、段号自己往前推。
        //    ⚠️ 这里**不许**再直接转发 `ev.text`（那正是"前半段被砍掉"）。
        const seg = tracker.push(ev);
        if (seg.partial) onEvt.onPartial?.(seg.partial);
        if (seg.final) onEvt.onFinal?.(seg.final);
        // 🔴 **"最后一包"之后要等它安静下来才算吐完**（2026-10-07 改）。
        //    原来这里是"第一帧就到站" ⇒ 真机上那一帧常常只是**半句**
        //    （实测：「我们」），于是"整段"被截尾、屏幕上的字跟着变短。
        //    ⚠️ 不发这一下的话，用户按了"停"之后界面会一直挂着（判据 W 抓过）——
        //       所以上限那一个钟必须留着（`FLUSH_MAX_MS`）。
        if (finished && !ended) {
          if (flushQuiet !== null) clearTimeout(flushQuiet);
          flushQuiet = setTimeout(endNow, FLUSH_QUIET_MS);
          if (flushCeiling === null) flushCeiling = setTimeout(endNow, FLUSH_MAX_MS);
        }
      });
      // 🔴 **握手那一关被拒**（HTTP 401/403…）单独报一类：`ws` 那条 `error` 只说
      //    "Unexpected server response: 401"，界面照那句只能编出一句没用的话。
      //    ⇒ 把状态码**明明白白**带出来（`kind:'auth'`），上层就能说"这两样它不认"。
      up.on('unexpected-response', (_req, res) => {
        const code = Number(res?.statusCode ?? 0);
        try { res?.resume?.(); } catch { /* 已经没了 */ }
        onEvt.onError?.({ kind: 'auth', code, message: `上游拒绝了这次连接（HTTP ${code}）` });
      });
      up.on('error', (err) => {
        onEvt.onError?.({ kind: 'upstream', message: String(err?.message ?? err).replace(/wss?:\/\/\S+/g, '（上游地址已隐去）').slice(0, 200) });
      });
      up.on('close', () => {
        closed = true;
        // 🔴 **没握上手就断了** = 那一跳没成（对应老那套"上游没回握手"）⇒ 如实报错
        if (!ready) {
          onEvt.onError?.({ kind: 'closed-before-ready', message: '还没握上手就断了' });
          return;
        }
        // 握过手 ⇒ 这是**正常收尾**（上游说完了 / 我们发了最后一包之后它关了）
        endNow();
      });
    },

    /** 送一包音频（**原样**，一个字节都不改）。 */
    audio(buf) {
      send(encodeAudioFrame(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)));
    },

    /** 收尾：发一个"最后一包"（空音频）⇒ 上游把最后那些字吐回来。 */
    finish() {
      finished = true;
      send(encodeAudioFrame(Buffer.alloc(0), { last: true }));
    },

    close() {
      try {
        up?.close();
      } catch {
        /* 已经没了 */
      }
      up = null;
      closed = true;
    },

    get isReady() {
      return ready;
    },
    get isClosed() {
      return closed;
    },
  };
}
