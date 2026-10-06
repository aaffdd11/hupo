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
 * **把上游回来的字接成"这一条连接的整段"**（纯逻辑 · 判据直接喂帧）。
 *
 * 🔴 **2026-10-07 按官方文档改了模型**（主人当天把豆包的协议文档贴过来）：
 *    文档原文 —— `result.text` = **"整个音频的识别结果文本"**，
 *    而 `result_type` 我们**没传** ⇒ 默认 `"full"`（**全量返回**）。
 *    ⇒ 上游每一帧给的**就是这条连接到目前为止的整段**（累积的）。
 *
 * ⚠️ **旧模型错在哪**（这一段以前是按"每一帧只管当前这一句"写的，还按分句编段号）：
 *    它把上游已经累积好的整段**再累积一遍** ⇒ 同一段在框里一遍、两遍、三遍……
 *    （主人 2026-10-07：*"还在，更夸张了，文字多的离谱了。"*）
 *
 * ── 现在的规矩（两种上游形状都认）────────────────────────────
 *   · **累积**（文档说的那种：新的一份以旧的一份开头）⇒ **整段替换**；
 *   · **只给新的一句**（有些引擎/参数会这样）⇒ **接在后面**；
 *   · **回声**（跟手里那份一样、或者是它的一部分）⇒ **一个字都不动**；
 *   · 接缝处**去重**（新那份的开头与旧那份的结尾最长重合那一段只算一次）。
 *
 * ⚠️ **段号永远是 0**（"这一条连接的整段"只有一段）—— 客户端按段替换，
 *    所以帧再多也不会越接越长。跨连接（55 秒上限换一条）由客户端那边接。
 *
 * @returns {{push:(frame:object)=>{partial?:{text:string,index:number},final?:{text:string,index:number}},
 *            whole:()=>string}}
 */
export function createSegmentTracker() {
  /** 这条连接到目前为止的**整段**。 */
  let text = '';

  /** `a` 的尾巴与 `b` 的开头最长重合几个字（接缝去重用）。 */
  const overlap = (a, b) => {
    const max = Math.min(a.length, b.length);
    for (let n = max; n > 0; n -= 1) {
      if (a.slice(a.length - n) === b.slice(0, n)) return n;
    }
    return 0;
  };

  return {
    /** 喂**一帧**上游回话 ⇒ 该往上发的半句 / 定稿（没有变化就什么都不带）。 */
    push(frame) {
      const list = Array.isArray(frame?.utterances) ? frame.utterances : [];
      const u = list.length > 0 ? list[list.length - 1] : null;
      const definite = u ? u.definite === true : false;
      // 🔴 **优先用"整个音频那一份"**（文档原话）；没有才退回最后那一条分句 / 顶层 text。
      const wholeText = typeof frame?.text === 'string' ? frame.text.trim() : '';
      const oneText = u && typeof u.text === 'string' ? u.text.trim() : '';
      const next = wholeText !== '' ? wholeText : oneText;
      // 空帧（还在听、一个字都没有）⇒ 什么都不动（只有"定稿"那一档要往下走）
      if (next === '') {
        return definite && text !== '' ? { final: { text, index: 0 } } : {};
      }
      if (text === '') {
        text = next;
      } else if (next === text) {
        // 一个字都没变 ⇒ 不发（帧少一点）
        return definite ? { final: { text, index: 0 } } : {};
      } else if (next.startsWith(text)) {
        // ★ **累积**（文档说的那种）⇒ 整段替换
        text = next;
      } else if (text.startsWith(next) || text.endsWith(next)) {
        // 比手里那份短、而且**已经在里面了**（开头或结尾都对得上）
        // ⇒ 迟到的旧帧 / 回声（累积式上游常见）⇒ **一个字都不动**
        return definite ? { final: { text, index: 0 } } : {};
      } else {
        // **只给了新的一句**（或者上游把前面那句重划了一遍）⇒ 接缝去重之后接上
        text = text + next.slice(overlap(text, next));
      }
      const out = { partial: { text, index: 0 } };
      // `definite` ＝ "这一句说定了"（文档：分句标识）—— 客户端拿它只当"这一段说完了"，
      // ⚠️ **不带整段之外的语义**（段号照旧 0）。
      if (definite) out.final = { text, index: 0 };
      return out;
    },
    /** **整段** —— `asr/end` 要的就是它。 */
    whole() {
      return text;
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
  // ── 临时诊断（见下面"帧形状"那一段；`docs/dev/217`）──
  let diagNo = 0;
  let diagPrev = '';
  const diagT0 = Date.now();
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
        // ── 🔴 **临时的形状诊断**（2026-10-07 · 只记数字，一个字的正文都不记）──
        //   为什么：主人念的那一段在框里**重复得离谱**，而"上游每一帧到底是什么形状"
        //   只能靠这个看清（我们连着几刀都是猜的）。判据：`docs/dev/217`。
        //   ⚠️ 查完就删（`docs/dev/217` 里记着删它的那一步）。
        {
          const t = typeof ev?.text === 'string' ? ev.text : '';
          const n = t.length;
          let pfx = 0;
          {
            const m = Math.min(n, diagPrev.length);
            while (pfx < m && t[pfx] === diagPrev[pfx]) pfx += 1;
          }
          const holds = diagPrev !== '' && t.includes(diagPrev);
          const inside = diagPrev !== '' && diagPrev.includes(t) && t !== diagPrev;
          diagNo += 1;
          log(
            `asr 帧形状 #${diagNo} · ${Math.round(Date.now() - diagT0)}ms · ` +
              `字 ${n} · 与上一帧共同开头 ${pfx} · 含上一帧 ${holds ? '是' : '否'} · ` +
              `被上一帧含 ${inside ? '是' : '否'} · 段 ${(ev?.utterances ?? []).length} · ` +
              `定稿 ${ev?.definite ? '是' : '否'} · 起点 ${Number.isFinite(ev?.utterances?.[0]?.start) ? ev.utterances[0].start : '-'}`,
          );
          diagPrev = t;
        }
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
