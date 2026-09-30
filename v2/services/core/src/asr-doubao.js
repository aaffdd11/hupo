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
 * 凭据从**环境变量**读（与老那套同一个纪律：`data/asr.env` 由 systemd 喂进来）。
 *
 * ⚠️ 三个名字：`DOUBAO_ASR_APPID` · `DOUBAO_ASR_TOKEN` ·（可选）`DOUBAO_ASR_RESOURCE`。
 *    ⚠️ 老那三个 `TENCENT_*` **不再读**（`甲`：完全换成豆包）。
 */
export function doubaoConfigFromEnv(env = process.env) {
  const appid = String(env.DOUBAO_ASR_APPID ?? '').trim();
  const token = String(env.DOUBAO_ASR_TOKEN ?? '').trim();
  const resource = String(env.DOUBAO_ASR_RESOURCE ?? '').trim() || DEFAULT_RESOURCE_ID;
  const url = String(env.DOUBAO_ASR_URL ?? '').trim() || DOUBAO_ASR_URL;
  // `HUPO_ASR_URL` 是**换上游**用的（自托管 / 取证用的桩）：给了它就直接连它
  // —— 让"整条链"能在**没有豆包钥匙**的情况下被真验一遍（判据打在客户端那一侧）。
  const upstream = String(env.HUPO_ASR_URL ?? '').trim() || null;
  const hasKey = Boolean(appid && token);
  return { appid, token, resource, url, upstream, configured: Boolean(upstream) || hasKey };
}

/** 建连头（**钥匙只在这一处进请求**）。 */
export function doubaoHeaders({ appid, token, resource, connectId }) {
  return {
    'X-Api-App-Key': String(appid),
    'X-Api-Access-Key': String(token),
    'X-Api-Resource-Id': String(resource || DEFAULT_RESOURCE_ID),
    'X-Api-Connect-Id': String(connectId),
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
  /** 还没握上手时先攒着（音频不能丢：丢一段就是丢一句话的开头）。 */
  const queue = [];
  let onEvt = {};

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
        : doubaoHeaders({ appid: config.appid, token: config.token, resource: config.resource, connectId: connectId() });
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
        // ⚠️ 每一帧都带"到目前为止的整段字"（`result.text`）⇒ 那就是"半句"；
        //    而"确定句"（`definite: true`）才是**这一段说完了**。
        if (ev.text) onEvt.onPartial?.({ text: ev.text, index: ev.index });
        if (ev.definite !== null) onEvt.onFinal?.({ text: ev.definite, index: ev.index });
        // 🔴 **"最后一包"之后的第一帧 = 整段说完了**（上游不一定马上关连接）——
        //    不发这一下的话，用户按了"停"之后界面会一直挂着（判据 W/那条测试抓过）。
        if (finished && !ended) {
          ended = true;
          onEvt.onEnd?.();
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
        if (!ended) {
          ended = true;
          onEvt.onEnd?.();
        }
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
