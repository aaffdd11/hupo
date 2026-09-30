// **把浏览器的麦克风接给"豆包大模型流式语音识别"**（服务端这一段 · 2026-10-01 换的）。
//
// ⚠️ **2026-10-01 之前这一跳是腾讯**；主人当天说*「语音识别，用豆包」*并选了
//    **「完全换成豆包」**（腾讯那三样撤掉）⇒ 上游那一跳现在住 `src/asr-doubao.js`
//    （**面向浏览器的这一套协议一个字没改**）。
//
// 为什么不让浏览器直连上游：**钥匙（Access Token）就得出现在浏览器里**。
// 密钥一旦下发，页面上的任何人都能拿它烧我们的额度 —— 而且这回不是"猜"，
// 是明文摆在 devtools 里。⇒ 音频走**我们这条**：浏览器 → 这台 → 豆包。
// 代价是这台机要中转音频（16k 单声道 ≈ 32 KB/s，一次连接几十秒，很小）。
//
// 协议（**新开一条 `/api/asr`，不动已冻结的聊天那条 `/api/stream`**）：
//   浏览器 → 这里：**二进制帧 = 16k 单声道 PCM**；文本帧 = `{type:'asr/stop'}`
//   这里 → 浏览器：`asr/ready` · `asr/partial{text}` · `asr/final{text}` ·
//                   `asr/end{text}` · `asr/capped` · `asr/error{reason,message}` ·
//                   `asr/unavailable{reason}`
//   （`partial` = 还在说的半句；`final` = 一句话定稿；`end` = 整段收尾）
//
// 🔴 **绝不做的事**：不认识/没配钥匙时**如实说**，不假装开麦；
//    **App ID / Access Token 一个字都不进日志**。

import nodeProcess from 'node:process';

import { createDoubaoUpstream, doubaoConfigFromEnv } from './asr-doubao.js';

/** 这条 WS 的路径。 */
export const ASR_PATH = '/api/asr';

/**
 * 一次最多听多久（毫秒）。
 *
 * ⚠️ 这个上限是**我们自己的**约定（老那套是因为腾讯内测版一条连接最多 1 分钟才这么定），
 *    豆包那边没有这条硬限 ⇒ **先照旧**（55 秒），要改是产品决定（一次说多久算一次）。
 */
export const ASR_MAX_MS = 55_000;

/**
 * 凭据只从**环境变量**读（`docs/dev/69-ASR-ROUTES.md`）：不进文件、不进仓库、不进日志。
 *
 * ⚠️ 名字是**豆包那一套**：`DOUBAO_ASR_APPID` / `DOUBAO_ASR_TOKEN`（＋可选
 *    `DOUBAO_ASR_RESOURCE`）—— 住 `src/asr-doubao.js`（**只有那一处**）。
 *    `HUPO_ASR_URL` 照旧是**换上游**用的（自托管 / 判据里的桩）。
 */
export const asrConfigFromEnv = (env = nodeProcess.env) => {
  const c = doubaoConfigFromEnv(env);
  // ⚠️ 老调用方认这两个名字（`engine` 用来报给客户端 / 日志）；豆包那边"引擎"就是资源 id。
  return { ...c, engine: c.resource };
};

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
 * @param {(info:{sub:string|null, seconds:number}) => void} [o.onSpend]
 *   ★ **P2-3：听了几分钟也要进那个账本**（一个账本三个计数器）。
 *   ⚠️ 一次会话**只报一次**（收尾那一刻）；`seconds` 从收到的字节推（不记内容）。
 */
export function createAsrRelay({ config, now = Date.now, maxMs = ASR_MAX_MS, log = () => {}, onSpend = null }) {
  /**
   * **这一条连接用哪份凭据**（P1-26）。
   *
   * ⚠️ 为什么是个函数：凭据**开机那一刻读一次**的话，
   *    ① 换一把钥匙就得**重启服务**（而重启是主人的动作）；
   *    ② 连"这是谁"这一维都没有。
   *    ⇒ `config` 可以是**一份**（老形状，判据里方便），
   *      也可以是 `(info) => 一份`（服务端走这条：按连接现取，见 `asr-creds.js`）。
   *
   * 🔴 `info.sub` 是**验过签的身份**（`server.js` 里从 `claim` 来）——
   *    它只用来"选哪份凭据"，**不是**从这条连接自己报的东西里读的。
   */
  const configFor = (info) => (typeof config === 'function' ? config(info) : config);

  /**
   * @param {import('ws').WebSocket} ws 面向浏览器那条（身份已验）
   */
  function attach(ws, info = {}) {
    const config = configFor(info) ?? {};
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
      log('asr：有人来了，但这台没配凭据 ⇒ 如实回 unavailable');
      send({ type: 'asr/unavailable', reason: 'not-configured' });
      return closeClient();
    }

    /**
     * **上游那一跳**（`asr-doubao.js` 造的那个东西；`null` = 还没连）。
     * ⚠️ 排队、握手、帧的编解码**都在它里面** —— 这一层只管"什么时候连、什么时候收尾"。
     * @type {{open:Function, audio:Function, finish:Function, close:Function}|null}
     */
    let up = null;
    let ended = false;
    let cap = null;
    let lastText = '';
    /** 最后见到的段号（收尾那条也带上，客户端好把最后一段收住）。 */
    let lastIndex = 0;

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
        log(`asr：会话结束 · 收到 ${bytes} 字节 ≈ ${(bytes / 32000).toFixed(1)} 秒 · 原因：${why}`);
        // ★ **P2-3：听了几分钟进那个账本**（一次会话**只报一次**）。
        //   ⚠️ 只报"多少秒"，不报内容；记账失败不许把收尾弄挂。
        if (!spent) {
          spent = true;
          try {
            onSpend?.({ sub: info?.sub ?? null, seconds: bytes / 32000 });
          } catch {
            /* 记账是旁路 */
          }
        }
        send({
          type: 'asr/end',
          text,
          index: typeof lastIndex === 'number' ? lastIndex : 0,
          // ★ P1-3：**为什么收的尾**（客户端据此决定"留字并说明白"还是"正常切回键盘"）
          reason,
        });
      }
      stopUpstream();
      closeClient();
    };

    /** 这一次会话的账报过没有（只报一次）。 */
    let spent = false;

    /** 收到多少音频（日志里只报这个数，不报内容）。 */
    let bytes = 0;
    /** 这次会话是怎么结束的（日志里要能看出"为什么"）。 */
    let why = '（还在跑）';
    /// **收尾原因**（机器可读，给客户端用）：`user-stop` / `upstream` / `engine` / `capped`。
    /// ⚠️ P1-3（2026-09-24）：客户端要靠它区分"用户自己按停"与"半路断了" ——
    ///    后者要**留着字、说明白、别切走**，让用户能"接着刚才那句说"。
    let reason = 'user-stop';

    /** 客户端说"开始"（或者直接推了音频）⇒ 去连上游。 */
    const start = () => {
      if (up) return;
      // ⚠️ 这一行是**排查用的**：主人手机上"按一下就没声了"，而服务端以前**什么都不记**
      //    ⇒ 只能猜。现在至少能看清"有没有走到这里、是谁的设备"。
      // ⚠️ 带上**来源**（`his-own` / `default`）—— 它是"到底用了谁的钥匙"的唯一线索，
      //    而它**不是秘密**（只是"从哪来"）。
      log(
        `asr：会话开始 · 资源 ${config.engine} · 凭据来源 ${config.source ?? 'default'}` +
          ` · 来自 ${String(info.ua ?? '未知设备').slice(0, 90)}`,
      );
      // ★ **上游那一跳 = 豆包**（`src/asr-doubao.js`；面向浏览器的协议一个字没改）
      up = createDoubaoUpstream({ config, log });
      up.open({
        onReady: () => {
          // 🔴 **握上手才说 ready**（对应老那套"上游回了 code 0 才算"）：
          //    没握上手就说"能听"，用户会对着一个没在听的麦克风说话。
          send({ type: 'asr/ready', engine: config.engine });
        },
        onPartial: ({ text, index }) => {
          if (text) lastText = text;
          if (typeof index === 'number') lastIndex = index;
          send({ type: 'asr/partial', text: text ?? '', index: typeof index === 'number' ? index : 0 });
        },
        onFinal: ({ text, index }) => {
          // ⚠️ `definite` 是**这一段说完了**（上游按句给）；`index` 是它的位置 ——
          //    客户端靠它**按段替换**（不然同一段会被接成一串重复的话）。
          if (text) lastText = text;
          if (typeof index === 'number') lastIndex = index;
          send({ type: 'asr/final', text: text ?? '', index: typeof index === 'number' ? index : 0 });
        },
        onEnd: () => {
          why = '上游说整段说完了';
          reason = 'upstream';
          finish(lastText);
        },
        onError: (e) => {
          // ⚠️ **一句话都不许带密钥**（URL / token 都不进回话）
          why = e?.kind === 'engine' ? `上游不成（错误码 ${e?.code ?? '?'}）` : '上游出错';
          reason = 'engine';
          log(`asr 上游出错（${e?.kind ?? '?'}）：${safeAsrMessage(e?.message)}`);
          send({
            type: 'asr/error',
            // ⚠️ 只有"上游明说不行"（错误帧 / 鉴权）才是 `engine`；
            //    连不上、握不上手、半路断都算 `upstream`（客户端那两档的处置不一样）。
            // ★ 2026-10-01：**握手那一关被拒**（`kind:'auth'`，例如 401）单独一类
            //   `bad-key` —— 界面照它说"这两样它不认，去控制台重取一次"，
            //   而不是那句没用的"识别那一头出错了，再按一次试试"（重试永远不会好）。
            reason: e?.kind === 'auth' ? 'bad-key' : e?.kind === 'engine' ? 'engine' : 'upstream',
            code: e?.code ?? null,
            message: safeAsrMessage(e?.message),
          });
          ended = true;
          stopUpstream();
          closeClient();
        },
      });
      cap = setTimeout(() => {
        why = '到点收手（我们自己的上限）';
        reason = 'capped';
        // 上限 ⇒ 我们提前收手，并**告诉客户端为什么**
        send({ type: 'asr/capped' });
        try {
          up?.finish();
        } catch {
          /* 已经没了 */
        }
        // 给它一点时间把最后的字吐回来；不给就一直等
        setTimeout(() => finish(), 1500);
      }, maxMs);
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // ★ 音频：**原样**交给上游那一跳（编码成豆包的帧是它的事；PCM 一个字节都不改）
        start();
        bytes += data.length ?? 0;
        try {
          up?.audio(Buffer.isBuffer(data) ? data : Buffer.from(data));
        } catch {
          /* 上游已经没了 ⇒ 让它自己那条 error/close 走收尾 */
        }
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
        // 用户按了"结束" ⇒ 请上游收尾（发一个"最后一包"空音频 ⇒ 它把最后那些字吐回来）
        start();
        try {
          up?.finish();
        } catch {
          /* 已经没了 */
        }
      }
    });

    ws.on('close', () => {
      if (cap) clearTimeout(cap);
      cap = null;
      log(`asr：浏览器那一边断了（收到 ${bytes} 字节）`);
      stopUpstream();
    });
    ws.on('error', () => {
      if (cap) clearTimeout(cap);
      cap = null;
      stopUpstream();
    });
  }

  // ⚠️ `config` 是函数时**开机这一刻不知道**有没有配（要等第一条连接）⇒ 如实回 `null`，
  //    **不许**回 `undefined` 让人以为是"没配"（那就是说假话）。
  return {
    configured: typeof config === 'function' ? null : Boolean(config?.configured),
    path: ASR_PATH,
    attach,
  };
}
