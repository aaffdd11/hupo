// **小程序的图标库**（主人 2026-09-23：*"你要做一个 icon 库，给每个小程序创造一个默认 icon"*）。
//
// 契约：`docs/dev/70-APP-ICONS.md`。这一份钉四件：
//   ① **库本身是干净的**：名字唯一、每个都在库里对得上、中性子集与关键词表不指向库外
//   ② 🔴 **认得出名字就挑得准**（中英文都认），而且**顺序**对（"记账"不许输给"记事"）
//   ③ 🔴 **认不出也一定给得出一个**：任何输入（空/怪/非字符串）都落在**中性**那一小撮里，
//      而且**同一个 id 每次都一样**（稳定 —— 不能今天一个图标明天另一个）
//   ④ 🔴 **建小程序时：给了白的用白的，没给/给错了自动配**（不抛错 ——
//      桌面上出现一个空白图标，比换一个相近的图标坏得多）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ICONS, ICON_KEYWORDS, NEUTRAL_ICONS, pickIcon, resolveIcon } from '../src/app-icons.js';
import { Apps } from '../src/apps.js';

// ══ ① 库本身 ═══════════════════════════════════════════════

test('★ 库：名字唯一、合法、够用（≥40）', () => {
  assert.ok(ICONS.length >= 40, `库太小了（${ICONS.length} 个）`);
  assert.equal(new Set(ICONS).size, ICONS.length, '有重名');
  for (const n of ICONS) {
    assert.match(n, /^[a-z0-9_-]+$/, `名字不合法：${n}`);
  }
});

test('🔴 原来那 14 个**一个都不许删**（老的小程序还在用）', () => {
  for (const old of ['dice', 'quiz', 'list', 'checklist', 'calculator', 'book', 'timer', 'star', 'paint', 'music', 'map', 'pet', 'wallet', 'leaf']) {
    assert.ok(ICONS.includes(old), `少了老图标：${old}`);
  }
});

test('🔴 中性子集与关键词表**只许指向库里的名字**（不然线上是空白方块）', () => {
  assert.ok(NEUTRAL_ICONS.length > 0, '中性子集是空的');
  for (const n of NEUTRAL_ICONS) assert.ok(ICONS.includes(n), `中性子集里有个库外的：${n}`);
  for (const [words, icon] of ICON_KEYWORDS) {
    assert.ok(words.length > 0, `这一对没有词：${icon}`);
    assert.ok(ICONS.includes(icon), `关键词表指向库外的图标：${icon}`);
  }
});

// ══ ② 挑得准 ═══════════════════════════════════════════════

test('★ 认得出名字 ⇒ 挑得准（中文与英文都认）', () => {
  const cases = [
    ['掷骰子', 'dice'], ['查天气', 'weather'], ['今天天气怎么样', 'weather'],
    ['记账本', 'wallet'], ['吃药提醒', 'pill'], ['背单词', 'school'],
    ['菜谱大全', 'recipe'], ['购物清单', 'checklist'], ['倒计时', 'timer'],
    ['孙子的小游戏', 'game'], ['打牌', 'game'], ['地图导航', 'map'],
    ['翻译一下', 'translate'], ['照片墙', 'photo'], ['养花记录', 'flower'],
    ['weather now', 'weather'], ['my todo', 'checklist'],
  ];
  for (const [title, want] of cases) {
    assert.equal(pickIcon(title, title), want, `「${title}」该挑 ${want}`);
  }
});

test('🔴 顺序对：具体词赢过笼统词（"记账"不许输给"记事"）', () => {
  assert.equal(pickIcon('记账本', 'ledger'), 'wallet');
  assert.equal(pickIcon('记事本', 'notes'), 'note');
  assert.equal(pickIcon('购物清单', 'shop-list'), 'checklist', '清单那一类优先于购物');
});

// ══ ③ 认不出也一定给得出 ═══════════════════════════════════

test('🔴 认不出 ⇒ 落在**中性**那一小撮里，而且是**稳定**的', () => {
  const a = pickIcon('我的小玩意儿', 'abc');
  const b = pickIcon('我的小玩意儿', 'abc');
  assert.equal(a, b, '★ 同一个小程序两次挑出来的必须是同一个（不许随机）');
  assert.ok(NEUTRAL_ICONS.includes(a), `认不出时该落中性子集，实际 ${a}`);
  // 负向对照：它**不是**随整个库乱落（不然"算一算"可能拿到"药"）
  assert.ok(ICONS.includes(a));
});

test('🔴 任何输入都给得出库里的一个（空 / 怪 / 非字符串）', () => {
  const inputs = [
    ['', ''], [null, null], [undefined, undefined], [42, 42], [{}, []],
    ['x'.repeat(500), 'y'.repeat(500)], ['🎲', '🎲'], ['   ', '   '],
  ];
  for (const [title, id] of inputs) {
    const got = pickIcon(title, id);
    assert.ok(ICONS.includes(got), `${JSON.stringify(title)}/${JSON.stringify(id)} ⇒ ${got} 不在库里`);
  }
});

test('★ 不同的 id 一般落到不同的图标（不是所有人都一样）', () => {
  // ⚠️ 标题要**真的没有关键词**（第一版这里写的是"小工具" —— 里面有"工具"，
  //    于是全部命中同一个图标，而判据红得**像是哈希坏了**。夹具自己踩了坑。）
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) seen.add(pickIcon('我的东西', `app-${i}`));
  assert.ok(seen.size >= 3, `40 个没关键词的小程序只用到 ${seen.size} 个图标 ⇒ 桌面上会一模一样`);
});

// ══ ④ resolveIcon / 建小程序那一侧 ═════════════════════════

test('🔴 `resolveIcon`：白的用白的（不算替换）、没给或乱写就自动配', () => {
  assert.deepEqual(resolveIcon({ icon: 'star', title: '记账本', id: 'x' }), {
    icon: 'star', substituted: false, asked: 'star',
  });
  assert.equal(resolveIcon({ title: '查天气', id: 'x' }).icon, 'weather');
  assert.equal(resolveIcon({ title: '查天气', id: 'x' }).substituted, true);
  assert.equal(resolveIcon({ icon: '不存在的图标', title: '查天气', id: 'x' }).icon, 'weather');
  assert.equal(resolveIcon({ icon: '不存在的图标', title: '查天气', id: 'x' }).substituted, true);
  assert.equal(resolveIcon({ icon: '  star  ', title: 'x', id: 'x' }).icon, 'star', '两边的空格要去掉');
  assert.equal(resolveIcon().substituted, true, '什么都不给也得给得出一个');
});

test('🔴 建小程序：图标给错了**不抛错**，自动配一个（桌面上不许空白）', () => {
  const apps = new Apps({ dir: tmpDir(), sub: 'u1' });
  const m = apps.create({
    id: 'tianqi', title: '查天气', icon: '这个东西不在白名单里',
    entry: 'index.html', files: { 'index.html': '<b>hi</b>' },
  });
  assert.equal(m.icon, 'weather', '★ 按名字自动配了一个');
  assert.ok(ICONS.includes(m.icon));
});

test('★ 建小程序：白的照旧（负向对照：不许被自动配覆盖）', () => {
  const apps = new Apps({ dir: tmpDir(), sub: 'u1' });
  const m = apps.create({
    id: 'mydice', title: '掷骰子', icon: 'star',
    entry: 'index.html', files: { 'index.html': '<b>hi</b>' },
  });
  assert.equal(m.icon, 'star');
});

test('🔴 建小程序：**一个字母都不给图标**也给得出（模型忘了传这一格）', () => {
  const apps = new Apps({ dir: tmpDir(), sub: 'u1' });
  const m = apps.create({
    id: 'yao', title: '吃药提醒',
    entry: 'index.html', files: { 'index.html': '<b>hi</b>' },
  });
  assert.equal(m.icon, 'pill');
});

// 临时目录（用完就删；测试机上的小事）
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
function tmpDir() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-icons-'));
}
