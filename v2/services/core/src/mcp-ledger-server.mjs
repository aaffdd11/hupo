#!/usr/bin/env node
// 账本那条 MCP 工具口（批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §7.1 / §7.3）。
//
// ── 它是什么 ──────────────────────────────────────────────
// 一个**独立的 stdio 进程**，由 dsh 的 `@deepseek-ai/dsh-mcp-client` 按那份
// `hupo-capabilities.yml` 拉起来。模型看到的是 `mcp__ledger__ledger_propose`
// 这一类名字，而**真正的写入在服务端那一个进程里**（经本机域套接字过去）。
//
// ── 三条不许破 ────────────────────────────────────────────
//   ① **本进程不写盘**。它只把请求转给服务端，写不写由那边说了算
//      （契约 §7.3 第 4 条：模型只能"提一条要写的"）。
//   ② **stdout 只许是 JSON-RPC**。诊断一律走 stderr —— 往 stdout 打一行
//      普通文字，对面就会把整条通道判成坏的（而且报错极难看懂）。
//   ③ **通道不通 ⇒ 明确失败**，不许"先记下来等会再写"（那就是说假话）。
//
// ── 为什么手写而不用 MCP SDK ──────────────────────────────
// stdio 这一层就是"一行一条 JSON-RPC"，而 SDK 是 dsh 自己的依赖、
// **不在本仓库的依赖表里**（本仓库只有 `ws` 一个依赖）。
// 为了四五个方法把一整个 SDK 加进来，是把供应链放大得没必要。

import nodeNet from 'node:net';
import nodeOs from 'node:os';
import nodeReadline from 'node:readline';

const SERVER_NAME = 'hupo-ledger';
const SERVER_VERSION = '1.0.0';

/** 协议版本：对面报一个我们认识的，就用它的；否则用我们默认的。 */
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const DEFAULT_VERSION = '2024-11-05';

const SOCKET = process.env.HUPO_LEDGER_SOCKET ?? '';
const TIMEOUT_MS = Number.parseInt(process.env.HUPO_LEDGER_TIMEOUT_MS ?? '15000', 10);

/** 一行一条的那个口。问一句、拿一句、挂断（服务端重启之后自己就好）。 */
function ask(payload) {
  return new Promise((resolve) => {
    if (!SOCKET) {
      resolve({ ok: false, error: '这条口没配（HUPO_LEDGER_SOCKET 是空的）' });
      return;
    }
    const conn = nodeNet.connect(SOCKET);
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { conn.destroy(); } catch { /* 尽力 */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '那边一直没有回话' }), TIMEOUT_MS);
    conn.setEncoding('utf8');
    conn.on('connect', () => {
      conn.write(`${JSON.stringify(payload)}\n`);
    });
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        finish({ ok: false, error: '那边的回答读不懂' });
      }
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `连不上账本那一侧（${err?.code ?? err?.message ?? err}）` });
    });
    conn.on('close', () => {
      clearTimeout(timer);
      finish({ ok: false, error: '那边没等回答就把口关上了' });
    });
  });
}

// ── 四条工具 ─────────────────────────────────────────────────
//
// ⚠️ 这些描述**就是模型读到的说明书**：它决定模型什么时候调、怎么调。
//    所以每一条都要写清"什么时候调"和"这一步写不写"。
//
// ⚠️ 工具定义会进**每一次请求**（token 成本）。四条已经是这件活需要的全部。

const FIELD_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', description: '事项：主人在那句话里说要做/做了的那件事，照他的词写' },
    qty: { type: 'number', description: '数量，正数' },
    unit: { type: 'string', description: '单位，照主人说的（台 / 小时 / 件…）' },
    unitPrice: { type: ['number', 'null'], description: '单价（元）。**主人没说钱就传 null，不许猜**' },
    tax: { type: ['boolean', 'string'], description: '含税传 true，不含税传 false，说不清传 "unknown"' },
    date: { type: 'string', description: '这是哪一天的账，YYYY-MM-DD' },
    said: { type: 'string', description: '主人让你记的那句**原话**（一个字都别改）' },
  },
  required: ['kind', 'qty', 'unit', 'tax', 'date', 'said'],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'ledger_propose',
    description:
      '把主人说的那笔账理成六项，**只算不写**，并给出该对他说的话。'
      + '凡是他说"记一笔""记一下"这类，**先调这个**，把你听到的（尤其钱数和日期）说回给他确认。'
      + '六项里有认不准的，这个工具会点名告诉你缺哪一项——那时**去问他**，不要自己猜。',
    inputSchema: FIELD_SCHEMA,
  },
  {
    name: 'ledger_write',
    description:
      '把**主人已经点头确认过**的那笔账记下来。'
      + '⚠️ 只有在他明确说"对""记吧"之后才调这里；没确认过就调，等于替他签字。'
      + '这里只提交那六项，账本会自己再校验一遍——校验不过就什么都没记下，并把哪一项没听准告诉你。',
    inputSchema: FIELD_SCHEMA,
  },
  {
    name: 'ledger_list',
    description:
      '把账本里的账目理成一段能直接粘走的文字（含合计）。'
      + '主人问"这个月记了什么""一共多少"这一类时调它，然后把你拿到的这段文字**原样给他**，不要自己重算。',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: ['string', 'null'], description: '只看某个月就传 YYYY-MM，看全部传 null' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'ledger_delete',
    description:
      '把**某一笔**账目收起来（进回收站，30 天里还能拿回来，不是真没了）。'
      + '⚠️ 只有主人明确说要删哪一笔、**而且你已经把那一笔念给他听过**之后才调。'
      + '按他说的那几项传（哪一天的、什么事），传 qty 和 unit 能更准。'
      + '要是同时对得上好几笔，这里会告诉你"有几笔"，那时**回去问清是哪一笔**，别猜着删。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '那一笔是哪一天的，YYYY-MM-DD' },
        kind: { type: 'string', description: '那一笔是什么事，照主人说的那个词' },
        qty: { type: ['number', 'null'], description: '数量（对得上好几笔时用它说清）' },
        unit: { type: ['string', 'null'], description: '单位（同上）' },
      },
      required: ['date', 'kind'],
      additionalProperties: false,
    },
  },
];

/** 把一次工具调用的结果折成 MCP 的 content。**失败也是一条正常回答**（`isError`）。 */
function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** 字段那一坨原样递给服务端（**这一层不校验** —— 校验只有一处：宿主）。 */
const fieldsOf = (args) => ({
  kind: args?.kind,
  qty: args?.qty,
  unit: args?.unit,
  unitPrice: args?.unitPrice === undefined ? null : args?.unitPrice,
  tax: args?.tax,
  date: args?.date,
});

async function callTool(name, args) {
  if (name === 'ledger_propose') {
    const r = await ask({ op: 'propose', fields: fieldsOf(args), said: args?.said });
    if (r.ok) return textResult(r.echo ?? '（没听出什么，让他再说一遍）');
    return textResult(`这条还不能记：${r.problemsText || r.error}`, true);
  }

  if (name === 'ledger_write') {
    const r = await ask({ op: 'write', fields: fieldsOf(args), said: args?.said });
    if (r.ok) {
      return textResult(`记下了：${r.entry?.kind ?? ''} ${r.entry?.qty ?? ''}${r.entry?.unit ?? ''}。`);
    }
    return textResult(`没记下来：${r.problemsText || r.error}`, true);
  }

  if (name === 'ledger_list') {
    const r = await ask({ op: 'list' });
    if (!r.ok) return textResult(`账本这一侧没答上来：${r.error}`, true);
    const text = renderList(r.items ?? [], r.totals ?? {}, args?.month ?? null);
    return textResult(text);
  }

  if (name === 'ledger_delete') {
    const date = args?.date;
    const kind = args?.kind;
    if (typeof date !== 'string' || date === '' || typeof kind !== 'string' || kind === '') {
      return textResult('没说是哪一笔，什么都没动。', true);
    }
    const r = await ask({
      op: 'delete',
      match: {
        date,
        kind,
        qty: args?.qty === undefined ? null : args.qty,
        unit: args?.unit === undefined ? null : args.unit,
      },
    });
    if (r.ok) return textResult('收起来了，30 天里想拿回来随时说。');
    // ⚠️ 对得上好几笔时**不许猜**：把候选念回去让他挑（认错一笔 = 删错账）。
    const extra = Array.isArray(r.candidates) && r.candidates.length > 0
      ? `：${r.candidates.map((c) => `${c.date} ${c.kind} ${c.qty}${c.unit}`).join('；')}`
      : '';
    return textResult(`没有收起来（${r.error}${extra}）`, true);
  }

  return textResult(`没有这个工具：${name}`, true);
}

/**
 * 出口那一段文字（契约 §八 第 3 件）。
 *
 * ⚠️ 三条口径都在这里落地：**一段文字不是表**、**含税说不清的进不了合计而且要说出来**、
 *    **没说钱的那几条也要说**（它们是"记了事没记钱"，不是 0 元）。
 * ⚠️ 用词过禁用词闸：不出现"记录""时间线"这一族。
 */
export function renderList(items, totals, month = null) {
  const list = (Array.isArray(items) ? items : []).filter(
    (r) => !month || String(r?.date ?? '').startsWith(month),
  );
  if (list.length === 0) return month ? `${month} 这个月一条都没有。` : '账上还一条都没有。';
  const lines = list.map((r) => {
    const money = r.unitPrice === null || r.unitPrice === undefined
      ? '没说钱'
      : `${r.qty * r.unitPrice}`;
    return `${r.date} ${r.kind} ${r.qty}${r.unit}｜${money}`;
  });
  const scope = month ? list : items;
  const t = month
    ? foldTotals(list)
    : totals;
  const tail = [`一共 ${t.total ?? 0}`];
  if ((t.notCounted ?? 0) > 0) tail.push(`有 ${t.notCounted} 条含不含税说不清，没有算进来`);
  if ((t.noPrice ?? 0) > 0) tail.push(`有 ${t.noPrice} 条没说钱，也没有算进来`);
  void scope;
  return `${lines.join('\n')}\n\n${tail.join('；')}。`;
}

/** 只看某个月时，合计要在这一小段里自己折一遍（服务端那份是全部的）。 */
function foldTotals(items) {
  let total = 0; let notCounted = 0; let noPrice = 0;
  for (const r of items) {
    if (r.unitPrice === null || r.unitPrice === undefined) { noPrice += 1; continue; }
    if (r.tax === 'unknown') { notCounted += 1; continue; }
    total += r.qty * r.unitPrice;
  }
  return { total: Math.round(total * 100) / 100, notCounted, noPrice };
}

// ── 主循环：一行一条 JSON-RPC ────────────────────────────────

const rl = nodeReadline.createInterface({ input: process.stdin });
let initializedVersion = DEFAULT_VERSION;

rl.on('line', (line) => {
  const s = line.trim();
  if (s === '') return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    // 读不懂的一条：**没有 id 可以回**（回了对面也认不出），记到 stderr 就算了。
    process.stderr.write('[ledger-mcp] 读不懂一行输入\n');
    return;
  }
  const { id, method, params } = msg;

  // 通知（没有 id）：只许**不回**。
  if (id === undefined) {
    if (method === 'notifications/initialized' || method === 'initialized') return;
    return;
  }

  if (method === 'initialize') {
    const want = params?.protocolVersion;
    initializedVersion = SUPPORTED.includes(want) ? want : DEFAULT_VERSION;
    reply(id, {
      protocolVersion: initializedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    callTool(name, args).then(
      (result) => reply(id, result),
      (err) => reply(id, textResult(`这一下没做成：${err?.message ?? err}`, true)),
    );
    return;
  }
  fail(id, -32601, `不认识这个方法：${method}`);
});

rl.on('close', () => {
  // 对面把 stdin 关了（dsh 退出）⇒ 跟着退出。
  process.exit(0);
});

process.stderr.write(`[ledger-mcp] 起来了（pid ${process.pid}，uid ${nodeOs.userInfo().uid}）\n`);
