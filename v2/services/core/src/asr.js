// **把浏览器的麦克风接给腾讯云混元 ASR**（服务端这一段）。
//
// 为什么不让浏览器直连腾讯云：**`SecretKey` 就得出现在浏览器里**。
// 密钥一旦下发，页面上的任何人都能拿它烧我们的额度 —— 而且这回不是"猜"，
// 是明文摆在 devtools 里。⇒ 音频走**我们这条**：浏览器 → 这台 → 腾讯云。
// 代价是这台机要中转音频（16k 单声道 ≈ 32 KB/s，一次连接最多一分钟，很小）。
//
// 协议（**新开一条 `/api/asr`，不动已冻结的聊天那条 `/api/stream`**）：
//   浏览器 → 这里：**二进制帧 = 16k 单声道 PCM**；文本帧 = `{type:'asr/stop'}`
//   这里 → 浏览器：`asr/ready` · `asr/partial{text}` · `asr/final{text}` ·
//                   `asr/end{text}` · `asr/capped` · `asr/error{reason,message}` ·
//                   `asr/unavailable{reason}`
//   （`partial` = 还在说的半句；`final` = 一句话定稿；`end` = 整段收尾）
//
// 🔴 **绝不做的事**：不认识/没配钥匙时**如实说**，不假装开麦；
//    **签名 URL 与密钥一个字都不进日志**（那个 URL 本身就是凭据）。

import nodeProcess from 'node:process';
import WebSocket from 'ws';

import { DEFAULT_ASR_ENGINE, newVoiceId, signAsrUrl } from './asr-sign.js';

/** 这条 WS 的路径。 */
export const ASR_PATH = '/api/asr';

/**
 * 一次最多听多久。
 * ⚠️ 腾讯那个内测版**一条连接最多 1 分钟**（`docs/dev/69-ASR-ROUTES.md` §四·补），
 * 所以**我们提前收手**，别等它半路把连接掐了（那样用户会看到"说到一半没了"）。
 */
export const ASR_MAX_MS = 55_000;

/**
 * 凭据只从**环境变量**读（`docs/dev/69-ASR-ROUTES.md`）：不进文件、不进仓库、不进日志。
 *
 * `HUPO_ASR_URL` 是**换上游**用的（自托管 / 取证用的桩）：给了它就直接连它，
 * 不再算签名。它让"整条链"能在**没有腾讯云钥匙**的情况下被真验一遍 ——
 * 判据打在客户端那一侧（V13），而不是"等钥匙到了再说"。
 */
export function asrConfigFromEnv(env = nodeProcess.env) {
  const appid = env.TENCENT_APPID ?? '';
  const secretId = env.TENCENT_SECRET_ID ?? '';
  const secretKey = env.TENCENT_SECRET_KEY ?? '';
  const engine = env.TENCENT_ASR_ENGINE || DEFAULT_ASR_ENGINE;
  const upstream = env.HUPO_ASR_URL || null;
  const hasKey = Boolean(appid && secretId && secretKey);
  return { appid, secretId, secretKey, engine, upstream, configured: Boolean(upstream) || hasKey };
}

/** 出错时只留一句人话：**不许把 URL（里面有签名）带出去**。 */
export const safeAsrMessage = (err) => {
  const m = String(err?.message ?? err ?? '');
  return m.replace(/wss?:\/\/\S+/g, '（上游地址已隐去）').slice(0, 200);
};

/**
 * 建一条中继。`attach(ws)` 把**已经验过身份**的那条连接接上。
 *
 * @param {object} o
 * @param {ReturnType<typeof asrConfigFromEnv>} o.config
 * @param {() => number} [o.now]
 * @param {number} [o.maxMs] 一次最多听多久（判据里会调小）
 * @param {(m: string) => void} [o.log]
 */
export function createAsrRelay({ config, now = Date.now, maxMs = ASR_MAX_MS, log = () => {} }) {
  /**
   * @param {import('ws').WebSocket} ws 面向浏览器那条（身份已验）
   */
  function attach(ws) {
    const send = (o) => {
      try {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
      } catch {
        /* 已经没了 */
      }
    };
    const closeClient = () => {
      try {
        ws.close(1000);
      } catch {
        /* 已经没了 */
      }
    };

    if (!config.configured) {
      // 如实说：这条部署没配钥匙。**绝不假装开麦。**
      send({ type: 'asr/unavailable', reason: 'not-configured' });
      return closeClient();
    }

    /** @type {WebSocket|null} */
    let up = null;
    let handshake = null;
    let ended = false;
    let cap = null;
    let lastText = '';
    /** 上游还没握上手时先攒着（音频不能丢：丢一段就是丢一句话的开头）。 */
    const queue = [];

    const upSend = (data) => {
      if (!up) return;
      if (up.readyState === WebSocket.OPEN) up.send(data);
      else if (up.readyState === WebSocket.CONNECTING) queue.push(data);
    };

    const upstreamUrl = () => {
      if (config.upstream) return config.upstream;
      return signAsrUrl({
        appid: config.appid,
        secretId: config.secretId,
        secretKey: config.secretKey,
        engine: config.engine,
        // 每次连接换一个新 UUID（文档要求）
        params: { voice_id: newVoiceId() },
        now: now(),
      }).url;
    };

    const stopUpstream = () => {
      if (cap) clearTimeout(cap);
      cap = null;
      try {
        up?.close();
      } catch {
        /* 已经没了 */
      }
    };

    /** 收尾：告诉客户端"整段结束了"，然后放掉两边。 */
    const finish = (text = lastText) => {
      if (!ended) {
        ended = true;
        send({ type: 'asr/end', text });
      }
      stopUpstream();
      closeClient();
    };

    /** 客户端说"开始"（或者直接推了音频）⇒ 去连上游。 */
    const start = () => {
      if (up) return;
      let url;
      try {
        url = upstreamUrl();
      } catch (err) {
        send({ type: 'asr/error', reason: 'upstream', message: safeAsrMessage(err) });
        return closeClient();
      }
      up = new WebSocket(url);
      cap = setTimeout(() => {
        // 内测版上限 ⇒ 我们提前收手，并**告诉客户端为什么**
        send({ type: 'asr/capped' });
        try {
          up?.send(JSON.stringify({ type: 'end' }));
        } catch {
          /* 已经没了 */
        }
        // 给它一点时间把最后的字吐回来；不给就一直等
        setTimeout(() => finish(), 1500);
      }, maxMs);

      up.on('open', () => {
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
        let j;
        try {
          j = JSON.parse(String(raw));
        } catch {
          return; // 不认识的一律丢（不猜）
        }
        // ── 第一句是握手：成不成全看它的 `code` ────────────────
        if (handshake === null) {
          handshake = j;
          if (j.code === 0) {
            send({ type: 'asr/ready', engine: config.engine });
          } else {
            // ⚠️ 只说服务端那句原话（鉴权 / 没开通 / 参数）——**不带密钥、不带 URL**
            send({
              type: 'asr/error',
              reason: 'engine',
              code: j.code,
              message: String(j.message ?? '').slice(0, 200),
            });
            ended = true;
            stopUpstream();
            closeClient();
          }
          return;
        }
        const text = j.result?.voice_text_str ?? '';
        if (text) lastText = text;
        const slice = j.result?.slice_type;
        if (slice === 0) send({ type: 'asr/partial', text });
        else if (slice === 1 || slice === 2) send({ type: 'asr/final', text });
        if (j.final === 1) finish(text);
      });
      up.on('error', (err) => {
        // ⚠️ **不许把签名 URL 写进日志/回话**（`safeAsrMessage` 负责）
        log(`asr 上游出错：${safeAsrMessage(err)}`);
        send({ type: 'asr/error', reason: 'upstream', message: safeAsrMessage(err) });
        ended = true;
        stopUpstream();
        closeClient();
      });
      up.on('close', () => {
        // 上游自己断了（没走到 final）⇒ 也算收尾，别让界面挂在那儿
        if (!ended) finish();
      });
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // ★ 音频：**原样**转给上游（一个字节都不改）
        start();
        upSend(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return;
      }
      let j = null;
      try {
        j = JSON.parse(String(data));
      } catch {
        return; // 不认识的文本帧一律丢
      }
      if (j?.type === 'asr/start') start();
      else if (j?.type === 'asr/stop') {
        // 用户按了"结束" ⇒ 请上游收尾（它会回 final=1）
        start();
        upSend(JSON.stringify({ type: 'end' }));
      }
    });

    ws.on('close', () => {
      if (cap) clearTimeout(cap);
      cap = null;
      stopUpstream();
    });
    ws.on('error', () => {
      if (cap) clearTimeout(cap);
      cap = null;
      stopUpstream();
    });
  }

  return { configured: config.configured, path: ASR_PATH, attach };
}
