// 「小程序 / app / 应用」这三个词**只有一个意思**：主人 hupo 桌面上那个图标。
//
// ── 为什么这一份必须有 ────────────────────────────────────────
// 主人说「帮我做一个小程序」时，最容易发生的**不是做错，是漂**：
// 助手顺着"小程序"这个词滑到**微信小程序**（问 AppID / AppSecret / 开发者工具），
// 或者滑到**原生应用**（问签名证书 / 包名 / 上架 / APK），
// 或者滑到**给外人访问的网站**（问域名 / 服务器 / 备案）。
// 这三种漂**什么都不会报错**：它照样答话、照样显得很专业 —— 只是做的不是那个东西。
// 那是本仓库反复栽的形状：**静默降级**（见 `persona.test.js` 顶上那段）。
//
// ⇒ 钉子写进了两处（两处都要在，缺一处就漂）：
//   ① 人格层 `hupo-persona.yml` 的「## 小程序」那一节；
//   ② 工具层 `src/mcp-apps-server.mjs` 的 `app_create` 说明。
//   这一份只查**文本**（快、每次都能跑）。"它真做出来没有"是另一回事，
//   走 `scripts/check-app-drift.mjs`（对活系统跑一轮真的）。
//
// ── 按语义点检，不把整句话写死 ─────────────────────────────────
// 措辞可以改（"只有一个意思"写成"意思只有一个"也行），但**钉子不许丢**：
// 三种漂移目标一个都不能少点名，而且"只有一个意思 / 只有他的桌面"这层意思必须在。
// ⇒ 见 [#NAILS]：每颗钉子是一组**意思**（可能有多种说法），不是一个固定字符串。
//
// ── 🔴 变异验证（负向对照）────────────────────────────────────
// 光断言"现在有"证明不了这道闸会红 —— 提取逻辑坏掉、返回空串时，
// 所有"必须包含"的断言都会**自动通过**（`persona.test.js` 记过同一课）。
// ⇒ 所以下面有一组**变异**：把钉子从**内存里的一份副本**上删掉一处，
//    要求判据**当场点名那一颗**。真实文本一个字都不动。
//
// 依据：`AGENTS.md` §五·5.2（服务端硬闸 = `npm test`）· 主人 2026-09-25 的改动。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

const HERE = nodePath.dirname(new URL(import.meta.url).pathname);
const PERSONA = nodePath.resolve(HERE, '..', 'hupo-persona.yml');
const MCP = nodePath.resolve(HERE, '..', 'src', 'mcp-apps-server.mjs');

const readText = (p) => nodeFs.readFileSync(p, 'utf8');

/**
 * **钉子**：每一颗是一组"意思"，不是一个写死的句子。
 *
 * ⚠️ 改措辞没关系；**把整颗删掉**、或者把某一种漂移目标从点名里拿掉 ⇒ 判据红。
 *    这正是主人要的那条线：**措辞可以改，钉子不许丢**。
 */
export const NAILS = Object.freeze([
  {
    id: 'three-words',
    label: '点名了"小程序 / app / 应用"这三个词（是这三个词在漂）',
    hit: (t) => t.includes('小程序') && /app/i.test(t) && t.includes('应用'),
  },
  {
    id: 'one-meaning',
    label: '"只有一个意思"（意思只有一个 —— 不是三种东西）',
    // 措辞可以换：`只有一个意思` / `意思只有一个` / `都是一个意思`
    hit: (t) => /(只有)?一个意思/.test(t),
  },
  {
    id: 'desktop-is-the-meaning',
    label: '那个意思就是**他的桌面**（不是别处）',
    hit: (t) => t.includes('桌面'),
  },
  {
    id: 'drift-wechat',
    label: '点名第一种漂：微信 / 支付宝那种小程序',
    hit: (t) => /(微信|支付宝)/.test(t),
  },
  {
    id: 'drift-native',
    label: '点名第二种漂：iOS / 安卓原生、安装包那一类',
    hit: (t) => /(原生|安装包|APK|IPA|TestFlight|签名证书|包名|上架)/i.test(t),
  },
  {
    id: 'drift-site',
    label: '点名第三种漂：给外人访问的网站',
    hit: (t) => /(网站|域名|服务器|备案)/.test(t),
  },
  {
    id: 'no-platform-ask',
    label: '没有"哪种平台"这回事（不许先问他平台）',
    hit: (t) => /(哪种平台|哪个平台)/.test(t),
  },
]);

/** 这颗钉子丢了哪些（返回 id 数组；空数组 = 全在）。 */
export function missingNails(text) {
  if (typeof text !== 'string') return NAILS.map((n) => n.id);
  return NAILS.filter((n) => !n.hit(text)).map((n) => n.id);
}

/** 给人看的一句话。 */
function explain(missing) {
  const by = new Map(NAILS.map((n) => [n.id, n.label]));
  return missing.map((id) => `「${by.get(id) ?? id}」`).join('、');
}

/**
 * **模型会读到的那两份字**。
 *
 * ① 人格层：只取两个 block scalar 的正文（**YAML 注释不进模型上下文**，
 *    里面解释"为什么禁它"是对的 —— 拿整个文件做 grep 会变成"解释一句禁令反而违规"，
 *    那种闸会被绕过去。见 `persona.test.js`）。
 *    再从正文里切出「## 小程序」那一节（到下一个 `## ` 标题为止；`### ` 子节算在这一节里）。
 *
 * ② 工具层：`app_create` 那一块的 `description`（从 `name: 'app_create'` 到 `inputSchema:`）。
 */
export function personaAppSection() {
  const lines = readText(PERSONA).split('\n');
  const body = [];
  let collecting = false;
  let indent = 0;
  for (const line of lines) {
    if (/^\s*persona(Prefix|Suffix):\s*\|-?\s*$/.test(line)) {
      collecting = true;
      indent = line.search(/\S/);
      continue;
    }
    if (!collecting) continue;
    if (line.trim() !== '' && line.search(/\S/) <= indent) {
      collecting = false;
      continue;
    }
    body.push(line);
  }

  const out = [];
  let inside = false;
  for (const line of body) {
    if (/^\s*##\s+小程序/.test(line)) {
      inside = true;
      out.push(line);
      continue;
    }
    if (inside && /^\s*##\s/.test(line)) break; // 下一个二级标题 ⇒ 本节结束
    if (inside) out.push(line);
  }
  return out.join('\n');
}

/** `app_create` 的 `description`（含前后那点结构，够查钉子就行）。 */
export function appCreateDescription() {
  const src = readText(MCP);
  const i = src.indexOf("name: 'app_create'");
  if (i < 0) return '';
  const j = src.indexOf('inputSchema:', i);
  return src.slice(i, j < 0 ? undefined : j);
}

// ── ① 那个「## 小程序」节真的在、而且是有内容的 ─────────────────────

test('人格层「## 小程序」那一节在（切不出来 = 后面全白查）', () => {
  const s = personaAppSection();
  assert.ok(s.length > 200, `只切出 ${s.length} 字 —— 提取逻辑八成坏了`);
  assert.ok(s.includes('小程序'), '切出来的必须真的是「小程序」那一节');
  assert.ok(s.includes('桌面'), '而且"桌面"是这一节的主语');
});

test('`app_create` 的说明切得出来（不是空串）', () => {
  const d = appCreateDescription();
  assert.ok(d.length > 100, `只切出 ${d.length} 字 —— 提取逻辑八成坏了`);
  assert.ok(d.includes('app_create'), '切出来的必须真的是那个工具');
});

// ── ② 钉子：人格层 ─────────────────────────────────────────────

test('🔴 人格层：三种漂移目标都被点名，而且"只有一个意思 / 只有他的桌面"在', () => {
  const missing = missingNails(personaAppSection());
  assert.equal(missing.length, 0, `人格层的钉少了：${explain(missing)}`);
});

// ── ③ 钉子：工具层 ─────────────────────────────────────────────

test('🔴 `app_create` 的工具说明里也有同一颗钉子（模型看得见的第二处）', () => {
  const missing = missingNails(appCreateDescription());
  assert.equal(missing.length, 0, `工具说明的钉少了：${explain(missing)}`);
});

// ── ④ 🔴 变异验证：删掉一处 ⇒ 判据当场点名那一颗 ─────────────────────

/** 把匹配的行删掉（**在内存里的一份副本上** —— 真文件一个字不动）。 */
const dropLines = (text, re) => text.split('\n').filter((l) => !re.test(l)).join('\n');

const MUTATIONS = Object.freeze([
  { id: 'drift-wechat', re: /微信|支付宝/ },
  { id: 'drift-native', re: /原生|安装包|APK|IPA|TestFlight|签名证书|包名|上架/ },
  { id: 'drift-site', re: /网站|域名|服务器|备案/ },
  { id: 'one-meaning', re: /一个意思/ },
  { id: 'no-platform-ask', re: /哪种平台|哪个平台/ },
]);

test('🔴 负向对照：两种来源都不许是空的（空了"必须包含"全会自动通过）', () => {
  for (const [name, s] of [['人格层', personaAppSection()], ['工具说明', appCreateDescription()]]) {
    assert.ok(s.length > 100, `${name}切出来只有 ${s.length} 字`);
    assert.equal(missingNails(s).length, 0, `${name}本来就缺钉子：${explain(missingNails(s))}`);
  }
});

for (const [name, source] of [
  ['人格层', personaAppSection],
  ['工具说明', appCreateDescription],
]) {
  test(`🔴 变异：把「${name}」的钉子各删一处 ⇒ 判据当场点名（措辞可改，钉子不许丢）`, () => {
    const real = source();
    for (const m of MUTATIONS) {
      const mutated = dropLines(real, m.re);
      assert.notEqual(mutated, real, `${name}：变异没改到任何东西（正则失效了？）`);
      const missing = missingNails(mutated);
      assert.ok(
        missing.includes(m.id),
        `${name}：把「${m.id}」整颗删掉了，判据却没红（只报了 ${JSON.stringify(missing)}）—— ` +
          '这道闸抓不住"钉子被删"，等于没有',
      );
    }
    // 全删光 ⇒ 必须全丢（最后一道：证明"缺什么报什么"不是偶然）
    assert.equal(
      missingNails('').length,
      NAILS.length,
      '空文本居然还有钉子"在" —— 判据写反了',
    );
  });
}
