// 会话事件 → 产品协议的翻译层。
//
// agent 说的是"会话日志事件"（turn/start、step/start、assistant/message、tool/call…），
// 客户端要的是产品协议（message/start、message/text、message/end、task/*…）。
// 这个模块就是那道缝。
//
// 三个必须做对的判断：
//
// 1. **一段话是"先应一声"还是"说结论"，看它有没有在工具之前出现。**
//    agent 的 step 1 通常是「收到，我先去查…」+ 工具调用；工具跑完的那一步才是结论。
//    前者是 quick，后者是 deep —— 但客户端把两者渲染成**同一个气泡**，
//    所以这只是节奏信息，不是"两条消息"。
//
// 2. **来源要等工具跑完才知道。** `message/start` 可能早就发出去了（那句"收到"），
//    所以最终来源挂在 `message/end` 上，客户端以 end 为准。
//
// 3. **一次用户发言可能对应多个 turn。** agent 可能在后台做完事之后
//    自己开新一轮回来说结果 —— 那一轮就是 `origin=proactive`。

import { MessageWriter, makeSegmenter, newId } from './conversation.js';

/**
 * 撞上输出长度上限时补的那句。
 *
 * 说事实、不问问题（主人的长期要求：不留人、不追问）。
 */
const TOO_LONG_LINE = '这条我说太长了，被长度限制截断，剩下的我没说完。';

/** 被中断（进程没了/被取消）时补的那句。 */
const INTERRUPTED_LINE = '这条我没说完就断了。';

/** 说了"某年有篇论文访谈了 N 人"这类具体出处，却一条来源都没有 —— 补的那句。 */
const UNSOURCED_LINE = '这条里的具体研究我没查出出处，用之前你核一下。';

/**
 * 这句话里有没有**需要出处**的具体断言（研究/论文/调查/样本量…）。
 *
 * 为什么单挑这几类：实测编造的都是这种 ——
 * 「上海师范大学 2010 年有一篇硕士论文，访谈了 227 名 3 到 5 岁幼儿」。
 * 年份、机构、样本量俱全，听起来特别可信，**而且一条来源都没有**。
 *
 * ⚠ 刻意写窄：只认"研究/论文/调查/样本量"这些**必须能查证**的说法。
 * 宽了会误伤（天气温度、时间、"聊了三条"这种都带数字）。
 */
export function looksLikeUnsourcedClaim(text) {
  const t = String(text ?? '');
  const patterns = [
    /(研究|论文|调查|报告|统计|数据)(表明|显示|发现|指出|证明|证实)/,
    /\d{4}\s*年.{0,14}(研究|论文|调查|报告|试验|期刊)/,
    /(访谈|样本|被试|受试)了?\s*\d+/,
    /\d+\s*(名|位|个)\s*[^，。；]{0,8}(儿童|幼儿|学生|患者|受访|对象|被试)/,
    /据.{0,10}(统计|调查|研究|报告)/,
    /(受访者|样本|被试|受试者|参与者)[^，。；]{0,12}\d+\s*(%|名|位|人)/,
    /(哈佛|耶鲁|斯坦福|北大|清华|中科院|上海师范大学|某大学).{0,12}(研究|论文|团队)/,
  ];
  return patterns.some((re) => re.test(t));
}

/** 从 tool/result 的 data.meta.sources 里捞结构化来源。 */
function sourcesOf(event) {
  const s = event?.data?.meta?.sources;
  if (!Array.isArray(s)) return [];
  return s
    .filter((x) => x && typeof x.url === 'string' && x.url)
    .map((x) => ({ title: String(x.title ?? '').trim(), url: String(x.url) }));
}

/** 把一次工具调用参数压成开发卡片上能看的一行。 */
function shortArgs(raw) {
  if (typeof raw !== 'string') return '';
  try {
    const o = JSON.parse(raw);
    const first = o.queries ?? o.query ?? o.command ?? o.path ?? o.url ?? o.prompt ?? o;
    return String(Array.isArray(first) ? first[0] : first).slice(0, 80);
  } catch {
    return raw.slice(0, 80);
  }
}

/**
 * 把 agent 写的 markdown 洗成人话。
 *
 * 为什么必须在服务端洗：客户端是**纯文本**气泡（SelectableText），
 * 原样透传的话用户会看到 `[中国天气网上海页](http://pc.weathercn...)` 这种东西。
 * 链接不丢 —— 变成结构化的来源，走 sources 通道（协议 R7）。
 *
 * @returns {{text: string, links: {title: string, url: string}[]}}
 */
export function plainText(input) {
  let text = String(input ?? '');
  const links = [];

  // [标题](url) → 标题，并登记来源
  text = text.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const title = String(label).trim();
    links.push({ title: title || url, url });
    return title || url;
  });

  // 剩下的裸链接：登记来源，长链接留域名（短链接原样留）
  text = text.replace(/(?<![(\w])(https?:\/\/[^\s)）】」]+)/g, (url) => {
    links.push({ title: '', url });
    if (url.length <= 40) return url;
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch {
      return '';
    }
  });

  text = text
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // 行内/围栏代码
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体
    .replace(/(^|\n)\s{0,3}#{1,6}\s*/g, '$1') // 标题
    .replace(/(^|\n)\s{0,3}[-*+]\s+/g, '$1') // 列表符号
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // agent 有时会在结尾自己列一份来源清单 —— 来源有专门的通道（协议 R7），
  // 正文里再列一遍就成了噪音。整段砍掉。
  text = text
    .replace(/(^|\n)\s*(sources?|references?|来源|参考资料|数据来源)\s*[:：][\s\S]*$/i, '')
    .trim();

  return { text, links };
}

/**
 * 一个会话的产品事件翻译器。**每个 agent 会话挂一个**，生命周期跟着会话走。
 *
 * 用法：
 *   const t = new TurnTranslator(conv, {
 *     nextProvenance: () => ({ origin, re, interrupts }),   // 调度器给"这一轮在回应谁"
 *     onTurnStart: (info) => {},                            // 调度器用来起计时器
 *     onTurnEnd: (info) => {},
 *     devStep: (phase, status, extra) => {},
 *   });
 *   agent.on('session-event', (p) => t.handle(p));
 */
export class TurnTranslator {
  constructor(conv, opts = {}) {
    this.conv = conv;
    this.opts = opts;
    /** DSH 的 turn 号 → 这一轮的产品消息 id。 */
    this.turnMessageId = new Map();
    /** 当前正在写的这一轮。 */
    this.current = null;
  }

  _dev(phase, status, extra) {
    this.opts.devStep?.(phase, status, extra);
  }

  handle({ event }) {
    if (!event || typeof event !== 'object') return;
    const t = event.type;
    const d = event.data ?? {};

    switch (t) {
      case 'turn/start':
        this._openTurn(d.turn);
        break;

      case 'assistant/message':
        this._onAssistantMessage(d);
        break;

      case 'tool/call':
        this._onToolCall(d);
        break;

      case 'tool/result':
        this._onToolResult(d);
        break;

      case 'turn/end':
        this._closeTurn(d);
        break;

      case 'session/title':
        // 会话标题：产品上暂时不用（客户端自己从首句取），只当开发信息
        this._dev('title', 'info', { detail: String(d.title ?? '').slice(0, 40) });
        break;

      default:
        break;
    }
  }

  // ── 一轮的开始 / 结束 ───────────────────────────────────────

  _openTurn(turn) {
    // 上一轮没收口就先收掉 —— 不能有永远不结束的气泡
    if (this.current) this._closeTurn({ turn: this.current.turn, reason: { kind: 'superseded' } });

    const prov = this.opts.nextProvenance?.() ?? {};
    const messageId = newId('m');
    this.turnMessageId.set(turn, messageId);

    const writer = new MessageWriter(this.conv, {
      messageId,
      agent: 'agent',
      origin: prov.origin ?? 'reactive',
      re: prov.re ?? [],
      interrupts: prov.interrupts ?? false,
    });

    this.current = {
      turn,
      writer,
      sawTool: false,
      textCount: 0,
      sources: [],
      escalated: false,
      startedAt: Date.now(),
    };
    this._dev('turn', 'start', { detail: 'agent 开始这一轮' });
    this.opts.onTurnStart?.(this.current);
  }

  _closeTurn(d) {
    const cur = this.current;
    if (!cur) return;
    this.current = null;

    // ⚠ 一轮**不是正常收尾**时，绝不能把半句话当成完整回答交给用户。
    //
    // 踩过（2026-09-14）：agent 撞上输出长度上限，`turn/end` 的 reason 是
    // `max-tokens`，可见文本断在半句（「一个是"避」「临海老」）——
    // 而这里原来**一律写 completed**，于是用户拿到一个看起来说完了、
    // 其实没说完的回答。主人来问"回答怎么断在半句"。
    // 说了具体研究/数据却一条来源都没有 ⇒ 补一句提醒。
    // 光靠提示词挡不住（模型顺口就把年份、机构、样本量编齐了），所以这里兜一道。
    const said = cur.writer.text;
    if (cur.sources.length === 0 && looksLikeUnsourcedClaim(said)) {
      cur.writer.chunk('deep', UNSOURCED_LINE, false);
      this._dev('say', 'info', { detail: '无来源的具体断言，已补提醒' });
    }

    const kind = d?.reason?.kind ?? 'completed';
    if (kind !== 'completed') {
      this._dev('turn', 'info', { detail: `非正常收尾：${kind}` });
      // 有正文才需要补一句；一句话都没有的时候直接给"断了"更清楚
      cur.writer.chunk('deep', kind === 'max-tokens' ? TOO_LONG_LINE : INTERRUPTED_LINE, false);
    }

    cur.writer.sources = cur.sources;
    cur.writer.end(kind === 'completed' ? 'completed' : 'failed');
    this._dev('turn', 'end', { ms: Date.now() - cur.startedAt, detail: `第 ${d.turn} 轮收口` });
    this.opts.onTurnEnd?.(cur);
  }

  /**
   * 「这件事我单独拿去做，完了跟你说」——**把手上这条收口，后面的话另起一条**。
   *
   * ⚠ 为什么必须这么做（2026-09-14 主人报了「你在补齐对话」）：
   *
   * 不这么做的话，事件顺序是这样的：
   *
   *   seq 571  开气泡1
   *   seq 572  写进气泡1  「收到，我去查…」
   *   seq 573  开气泡2    「这件事比我想的久，我单独拿去做，完了跟你说。」
   *   seq 578  写回气泡1  ← 答案长回了**上面那个**气泡
   *
   * 客户端按 seq 排序、一个 messageId 一个气泡 —— 于是用户看到的是
   * **上面那个气泡在"我拿去做"之后还在继续往后长**。这就是**时间倒流**：
   * 反馈没有按时间说话，看起来像在"补齐对话"。
   *
   * 收口之后再另起一条（标成 `proactive`：这是"做完了回来说"），
   * 时间线就严格单调了：应一声 → 我拿去做 → 做完了结果是这些。
   */
  handoff() {
    const cur = this.current;
    if (!cur || cur.handedOff) return null;
    cur.handedOff = true;

    // 手上这条（"收到，我去查…"）就此收口。没说过话就不用收 —— 不然留个空气泡。
    if (cur.writer.started) {
      // ⚠ 应一声那条**不带来源**：来源属于**结论**，不属于"我去了"。
      //   实测踩过：工具在挪走之前就返回了，16 条来源全挂到"收到，我去查…"上，
      //   而真正给结论的那条一条来源都没有 —— 正好挂反了。
      cur.writer.sources = [];
      cur.writer.end('completed');
    }

    // 同一轮里后面的话 = 做完了回来说，另起一条
    cur.writer = new MessageWriter(this.conv, {
      messageId: newId('m'),
      agent: 'agent',
      origin: 'proactive',
      re: [],
    });
    cur.textCount = 0;
    cur.sawTool = false;
    // cur.sources **保留**：它们跟着答案走
    return cur;
  }

  /** 外部强制收口（超时/取消/进程挂了都用它，保证不留白）。 */
  forceClose(reason = 'failed') {
    const cur = this.current;
    if (!cur) return null;
    this.current = null;
    cur.writer.sources = cur.sources;
    cur.writer.end(reason);
    this.opts.onTurnEnd?.(cur);
    return cur;
  }

  // ── 内容 ───────────────────────────────────────────────────

  _onAssistantMessage(d) {
    const cur = this.current;
    if (!cur) return;
    const blocks = d?.message?.content;
    if (!Array.isArray(blocks)) return;

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;

      if (b.type === 'text') {
        const { text, links } = plainText(b.text);
        if (!text) continue;
        // 正文里写出来的链接也当来源（工具返回的 meta.sources 是另一路）
        for (const l of links) {
          if (!cur.sources.some((x) => x.url === l.url)) cur.sources.push(l);
        }
        // 工具之前说的话 = 先应一声（quick）；工具之后 = 说结论（deep）
        const block = cur.sawTool || cur.textCount > 0 ? 'deep' : 'quick';
        cur.textCount += 1;
        // 事件是**整段**到达的（没有 token 级流），但仍按标点切句放行，
        // 保持协议那条"每段都是整句"的纪律。
        const seg = makeSegmenter((s) => cur.writer.chunk(block, s, false));
        seg.push(text);
        seg.flush();
        this._dev('say', 'info', { detail: text.slice(0, 60) });
        continue;
      }

      if (b.type === 'reasoning') {
        this._dev('think', 'info', { detail: String(b.text ?? '').slice(0, 80) });
        continue;
      }

      if (b.type === 'tool-call') {
        cur.sawTool = true;
        this._dev('tool', 'start', { detail: String(b.name ?? '?') });
      }
    }
  }

  _onToolCall(d) {
    const cur = this.current;
    if (!cur) return;
    cur.sawTool = true;
    this._dev('tool', 'start', { detail: `${d.name ?? '?'} ${shortArgs(d.arguments)}`.trim() });
  }

  _onToolResult(d) {
    const cur = this.current;
    if (!cur) return;
    for (const s of sourcesOf({ data: d })) {
      if (!cur.sources.some((x) => x.url === s.url)) cur.sources.push(s);
    }
    this._dev('tool', 'end', { detail: cur.sources.length ? `${cur.sources.length} 条来源` : '完成' });
  }
}
