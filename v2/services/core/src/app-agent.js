// **替小程序跑一轮"限定档"的 agent**（契约 `docs/dev/148-APP-FULL-SET.md` §三）。
//
// ── 它补的是哪一条 ────────────────────────────────────────
//   目标里写的是"走那一间的 agent，**限定档** ＋ 配额 ＋ 每次可见"。
//   配额与"每次可见"已经落地；这一份补的是**限定档**：
//   替小程序跑的那一轮**不挂能力层**，并且挂上 `hupo-app-agent.yml`
//   （把 bash / 后台活 / 派活 / 加载说明那些**能在世界里动手**的工具关掉）。
//
// ── 🔴 四条不许破 ──────────────────────────────────────────
//   ① **只给"替小程序跑的那一轮"挂**（挂到主人自己的对话上 ＝ 把他的助手的手捆起来）；
//   ② **cwd 是那个小程序自己的那一间**（它读得到自己的文件；万一写了也写在自己家里）；
//   ③ **跑完核一遍工作区**：动过 ⇒ **如实说**（`changed` 非空），不许当"它只是答了个问题"；
//   ④ **认不出来就如实失败**（起不来 / 超时 / 没正文 ⇒ `{ok:false}`），**绝不**编一句回答。
//
// ⚠️ **如实说一条**：`tool-fs` 今天关不掉"写"那一半 ⇒ 那一轮**还写得了那个工作区**。
//    要彻底只读得另起一个 dsh profile（`~/.dsh/profiles/**` 是 `strict`，要主人点头）。
//    在那之前，②③ 两条（自己那一间 ＋ 跑完核对）就是这一层的地板。

import nodePath from 'node:path';
import nodeUrl from 'node:url';

import { changedFiles, converseWithReviewDsh, snapshotTree } from './review-agent.js';

/** 这一层补丁在哪儿（同目录、随代码走）。 */
export const APP_AGENT_PATCH = nodePath.join(
  // ⚠️ 它在**上一级**（和 `hupo-persona.yml` / `hupo-capabilities.yml` / `hupo-model-proxy.yml` 住一起）
  nodePath.dirname(nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url))),
  'hupo-app-agent.yml',
);

/** 一轮最多等多久。⚠️ 比"评审"短一点：那是页面在等的活（它还能再问几次）。 */
export const APP_AGENT_TIMEOUT_MS = 90_000;

/**
 * **替小程序问那一句时，喂给 agent 的正文**。
 *
 * 🔴 **它只是第二道**（第一道是补丁：那些工具**根本不在**）——
 *    但一句话说清"这是小程序问的、你只回答"仍然是必要的（模型知道自己在跟谁说话）。
 */
export function buildAppAgentPrompt({ title = '', prompt = '' } = {}) {
  const name = typeof title === 'string' && title.trim() !== '' ? title.trim() : '一个小程序';
  const q = typeof prompt === 'string' ? prompt.trim() : '';
  return [
    `有一个小程序（名字：${name}）替它的主人问你一件事：`,
    '',
    q,
    '',
    '🔴 你**只回答这件事本身**：不要改文件、不要跑命令、不要发任何东西（这些工具这一轮也没给你）。',
    '需要动手才能办的事 ⇒ 直接说清"这件事得他本人同意，我才能动手"。',
    '用一两句人话回答，别写长篇。',
  ].join('\n');
}

/**
 * **跑一轮**（起一台无头 dsh → 问一句 → 收正文 → 核工作区 → 收干净）。
 *
 * @param {object} o
 * @param {object} o.cfg            同 `review-agent.js`（`dshBin` / `agentProfile` / `dshHome` …）
 * @param {string} o.cwd            那个小程序自己的工作区
 * @param {string} o.title
 * @param {string} o.prompt
 * @param {Function} [o.spawnFn]    判据注入假 dsh 用
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ok:true, text:string, changed:string[], usage:object|null}
 *                   | {ok:false, error:string}>}  **绝不抛**
 */
export async function runAppAgent({
  cfg = {},
  cwd,
  title = '',
  prompt = '',
  spawnFn,
  timeoutMs = APP_AGENT_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const before = (() => {
    try {
      return snapshotTree(cwd);
    } catch {
      return {};
    }
  })();
  let got = null;
  try {
    got = await converseWithReviewDsh({
      // ★ **这一层只加在"替小程序跑"这一轮上**（`extraPatchPaths`）
      cfg: { ...cfg, extraPatchPaths: [...(Array.isArray(cfg.extraPatchPaths) ? cfg.extraPatchPaths : []), APP_AGENT_PATCH] },
      cwd,
      prompt: buildAppAgentPrompt({ title, prompt }),
      ...(spawnFn ? { spawnFn } : {}),
      timeoutMs,
      log,
    });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  const text = typeof got?.text === 'string' ? got.text.trim() : '';
  if (text === '') return { ok: false, error: '它这一轮一句话都没说' };
  const after = (() => {
    try {
      return snapshotTree(cwd);
    } catch {
      return before;
    }
  })();
  let changed = [];
  try {
    changed = changedFiles(before, after) ?? [];
  } catch {
    changed = [];
  }
  return { ok: true, text, changed: Array.isArray(changed) ? changed : [], usage: got?.usage ?? null };
}
