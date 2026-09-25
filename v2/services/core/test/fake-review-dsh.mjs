// **假的那台"评审 DSH"**：说和 `dsh --profile sdk` **同一套** SDK JSON-RPC，
// 但回的是**一份写死的结论**（判据里不许真打模型 · 96 的纪律）。
//
// 为什么要有它（和 `fake-harness-dsh.mjs` 同一个理由）：
//   "spawn ＋ stdio 分帧 ＋ initialize ＋ session/prompt ＋ 收进程 ＋ 解析结论 ＋ 记账"
//   这一段**必须真跑** —— mock 掉它就等于把最容易错的那一段排除在判据之外。
//
// 场景由环境变量选：
//   （默认）                  initialize 成，一轮回 `FAKE_REVIEW_ANSWER`（默认一份 pass）+ usage
//   FAKE_REVIEW_ANSWER=<json> 直接指定它回的那份结论（判据用它造"高风险 / reject / 认不出"）
//   FAKE_REVIEW_SILENT=1      一句话都不说（只发 turn/end）⇒ 判据验"没结论 ⇒ 不自动放行"
//   FAKE_REVIEW_NEVER_INIT=1  `initialize` 永远不回 ⇒ 判据验"起不来 / 超时 ⇒ 不自动放行"
//   FAKE_REVIEW_WRITE_CWD=1   先往**自己的 cwd**（那个一次性临时目录）写一个文件再回
//                             ⇒ 判据验"cwd 不是工作区、而且跑完就清掉"
//   FAKE_REVIEW_WRITE_DIR=<abs> 先往这个绝对路径写一个文件再回
//                             ⇒ 判据验"评审真去动工作区 ⇒ 当场抓住（不自动放行）"
//   FAKE_REVIEW_USAGE=<json>  指定它带回来的 usage（默认 DeepSeek 那种三格形状）

import fs from 'node:fs';
import nodePath from 'node:path';

const env = process.env;

const DEFAULT_ANSWER = JSON.stringify({
  summary: '读了一遍：只问一句模型，没有别的出网点。',
  risks: [],
  rating: 0,
  verdict: 'pass',
});

/** 默认那份 usage：**DeepSeek 那种三格形状**（`prompt_cache_hit_tokens` 是 cache read）。 */
const DEFAULT_USAGE = { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 20 };

let buf = '';
let seq = 0;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    onMessage(msg);
  }
});

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
const event = (type, data) => {
  seq += 1;
  notify('session.event', { event: { type, seq, time: 1_700_000_000_000, data } });
};
const status = (s) => notify('session.status', { sessionId: 'review-fake', status: s });

function onMessage(msg) {
  if (msg.method === 'initialize') {
    if (env.FAKE_REVIEW_NEVER_INIT === '1') return; // 一声不吭 ⇒ 判据走超时那条路
    reply(msg.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
    return;
  }
  if (msg.method === 'shutdown') {
    reply(msg.id, {});
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (msg.method === 'session/prompt') {
    reply(msg.id, { messageId: `pm_${seq}` });
    status('running');
    // ★ 反例那两档：**它真去写盘**
    if (env.FAKE_REVIEW_WRITE_CWD === '1') {
      try {
        fs.writeFileSync(nodePath.join(process.cwd(), 'evil.txt'), '评审不该写这个\n');
      } catch {
        /* 写不进去也不影响判据（判据看的是工作区没被动） */
      }
    }
    if (env.FAKE_REVIEW_WRITE_DIR) {
      try {
        fs.mkdirSync(env.FAKE_REVIEW_WRITE_DIR, { recursive: true });
        fs.writeFileSync(nodePath.join(env.FAKE_REVIEW_WRITE_DIR, 'evil.txt'), '评审不该写这个\n');
      } catch {
        /* 同上 */
      }
    }
    if (env.FAKE_REVIEW_SILENT !== '1') {
      let usage = null;
      try {
        usage = env.FAKE_REVIEW_USAGE ? JSON.parse(env.FAKE_REVIEW_USAGE) : DEFAULT_USAGE;
      } catch {
        usage = null;
      }
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '（评审的推理原文，不该进任何记录）' },
            { type: 'text', text: env.FAKE_REVIEW_ANSWER ?? DEFAULT_ANSWER },
          ],
        },
        ...(usage ? { usage } : {}),
      });
    }
    event('turn/end', { turn: 1, reason: { kind: 'completed' } });
    status('idle');
    return;
  }
  if (msg.id !== undefined) reply(msg.id, {});
}

// ⚠️ "那个进程还活着"不依赖 stdio 开着（同 `fake-harness-dsh.mjs`）。
setInterval(() => {}, 1 << 30);
process.stdin.on('end', () => {});
