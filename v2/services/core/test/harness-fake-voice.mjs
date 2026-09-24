// **假 DSH 的"声音"与"事件形状"** —— `fake-harness-dsh.mjs` 与判据**共用同一份**。
//
// ⚠️ 为什么抽出来：判据要拿**它自己期望的那一条**去和真收到的比。
//    两边各写一份 ⇒ 判据只在"我以为的形状"上成立（那正是本仓库最忌的：
//    闸和被测的东西一起漂）。⇒ 造事件的那份代码**只有一处**。
//
// 🔴 这里也是**判据 H5 能被反着验**的地方：它只认自己收到的 `--patch`
//    —— 挂了人格 patch，它就用"琥珀"那个声音说话（于是"没有琥珀人格"那条判据必须红）。

import fs from 'node:fs';

/** DSH 本人那句固定开场（`docs/dev/81-HARNESS-ENTRY.md` §四实测）。 */
export const DSH_OPENING = '我是 DeepSeek Harness 驱动的 AI 编码助手。';

/** 琥珀人格的特征串（判据 H5 用它当"这是琥珀不是 DSH"的标记）。 */
export const AMBER_MARK = '私人助理';

/** DSH 本人那一轮的工具清单（没挂能力层）。 */
export const DSH_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'glob'];

/** 挂了能力层才会多出来的那几条（账本 / 小程序 / 画图）。 */
export const CAP_TOOLS = ['ledger_append', 'ledger_search', 'apps_build', 'draw_image'];

const readPatch = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

/**
 * **它会说什么、会带哪些工具** —— 只看 `argv`（真 dsh 也是这么读 `--patch` 的）。
 *
 * @param {string[]} argv 子进程收到的参数（`process.argv.slice(2)` 或 spawn 的 `args`）
 */
export function voiceFor(argv = []) {
  const patches = [];
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === '--patch') patches.push(argv[i + 1]);
  }
  const texts = patches.map(readPatch);
  const personaText = texts.find((t) => t.includes('personaPrefix')) ?? null;
  const capsText = texts.find((t) => t.includes('mcp-ledger')) ?? null;
  return {
    patches,
    persona: Boolean(personaText),
    capabilities: Boolean(capsText),
    systemMessage: personaText ? `你是「助手」——主人的${AMBER_MARK}。` : 'You are DeepSeek Harness, a coding agent runtime.',
    assistantText: personaText ? `好的主人，你的${AMBER_MARK}在。` : DSH_OPENING,
    tools: capsText ? [...DSH_TOOLS, ...CAP_TOOLS] : DSH_TOOLS,
  };
}

/** `initialize` 回来之后那一批"策略/预设"事件（§四实测里有它们）。 */
export function startupEvents() {
  return [
    { type: 'permission/preset', data: { preset: 'default' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'never-ask' } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', items: [] } },
  ];
}

/** 一轮：§四实测里那 14 种 `session.event`，一种都不缺。 */
export function turnEvents(turn, voice) {
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'step/start', data: { turn, step: 1 } },
    { type: 'system/message', data: { role: 'system', content: [{ type: 'text', text: voice.systemMessage }], id: 'sys_1' } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '你好' }], id: 'usr_1' } },
    // ★ 这一条里就是"这一轮的工具清单"（§四点名）
    { type: 'request/header', data: { provider: 'deepseek-official', model: 'deepseek-flash', tools: voice.tools } },
    { type: 'request/context', data: { tokens: 1234, messages: 3 } },
    { type: 'session/title', data: { title: '打个招呼' } },
    {
      type: 'assistant/message',
      data: {
        turn,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '他在跟我打招呼，回一句。' },
            { type: 'text', text: voice.assistantText },
          ],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
          id: 'm_1',
        },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    },
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ];
}

/**
 * **原样**那条判据用的探针帧：字段刻意"歪"一点（带空格的键、嵌套数组、空对象、
 * `null`、负数、小数、`false`）—— **任何裁剪/改名/丢字段都会让它对不上**。
 */
export const SENTINEL_FRAME = {
  jsonrpc: '2.0',
  method: 'session.event',
  params: {
    event: {
      type: 'harness/原样',
      seq: 7,
      time: 1_700_000_000_000,
      data: {
        text: '原样',
        '带空格 的键': true,
        list: [1, 2, { deep: null }],
        empty: {},
        negative: -3.5,
        flag: false,
      },
    },
  },
};

/** 把一帧包成 `session.event` 通知（和真 DSH 一样：`method` 用点）。 */
export const asNotification = (frame) => frame;

/** 一轮里的 `assistant/message` 正文（判据 H4/H5 只看这个）。 */
export function assistantTexts(raws) {
  return raws
    .filter((m) => m?.params?.event?.type === 'assistant/message')
    .flatMap((m) => m.params.event.data?.message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? ''));
}
