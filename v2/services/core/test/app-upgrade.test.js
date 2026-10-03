// **升级：分级派（`C1`）＋ 粒度（`C3`）**（`D4.24` · 2026-10-03 主人定）—— 离线判据。
//
// 口径与理由见 `docs/dev/168-PUBLISH-RUN-UPGRADE.md`；闸脚本 `scripts/check-publish-run-upgrade.sh`。
//
// 这一份钉六件（每条都带**负向对照**）：
//   D1 **契约版未变 ⇒ 换字节**；**契约版变了 ⇒ 请 AI 重写**（两个方向都验）
//   D2 🔴 **契约版未变 ⇒ 重写计数 = 0**；变了 ⇒ **> 0**（计数是行为读数）
//   D3 **判定只有一处**（源码级：那条比较与结论全仓各只一份）
//   D4 **粒度默认按用户跟**；★ 负向对照：显式留旧版的那一个 ⇒ **不跟**，且状态**看得出来**
//   D5 **不过度**：没有升级需求 ⇒ 一个字节都不写（整棵树逐文件 hash 不变）
//   D6 **读不出契约版 ⇒ 不猜**（抛 `不可算`，不许默认请一次 AI、也不许默认不请）

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { Apps } from '../src/apps.js';
import {
  DEFAULT_UPGRADE_MODE,
  UPGRADE_KINDS,
  UpgradeBook,
  UpgradeError,
  UpgradePolicy,
  decideUpgrade,
  planUpgrade,
} from '../src/app-upgrade.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const SRC = nodePath.join(HERE, '..', 'src');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});
const tmp = () => {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-up-'));
  tmpDirs.push(d);
  return d;
};
const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };

function world(tag = 'w') {
  const dir = tmp();
  return { dir, apps: new Apps({ dir, sub: 'u1' }), tag };
}

const make = (w, id, body = '<p>x</p>') => w.apps.create({
  id, title: id, icon: 'dice', entry: 'index.html', files: { 'index.html': body },
});

/** **假造一次契约 `N→N+1`**（`90` Q7.5 点名的验法）：只改清单里那个形状号。
 *  ⚠️ 版本目录是 `0444` 的（不可变）⇒ 先放开权限再写（只在测试的临时盘上）。 */
function setSchema(w, id, version, schema) {
  const p = nodePath.join(w.apps.versionDir(id, version), 'manifest.json');
  nodeFs.chmodSync(p, 0o644);
  const j = JSON.parse(nodeFs.readFileSync(p, 'utf8'));
  j.schema = schema;
  nodeFs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
}

/** 整棵树逐文件 sha256（判"一个字节都没动"用）。 */
function treeSha(root) {
  const out = [];
  const walk = (rel) => {
    let es = [];
    try { es = nodeFs.readdirSync(rel === '' ? root : nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of [...es].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { out.push(`${next}/`); walk(next); continue; }
      out.push(`${next}:${nodeFs.readFileSync(nodePath.join(root, next)).toString('base64')}`);
    }
  };
  walk('');
  return out.join('\n');
}

/** 一个 app 、三版：v1/v2 同契约，v3 契约变了。 */
function threeVersions(tag) {
  const w = world(tag);
  make(w, 'a');
  make(w, 'a');
  make(w, 'a');
  setSchema(w, 'a', 3, 2);
  return w;
}

// ════════════════════════════════════════════════════════════════
// D1 · 契约版未变 ⇒ 换字节；变了 ⇒ 请 AI
// ════════════════════════════════════════════════════════════════

test('🔴 D1：契约版**逐字相同** ⇒ 换字节（不请 AI）；**变了** ⇒ 请 AI 重写', () => {
  const w = threeVersions('D1');
  assert.equal(w.apps.shapeVersion('a', 1), 1);
  assert.equal(w.apps.shapeVersion('a', 2), 1);
  assert.equal(w.apps.shapeVersion('a', 3), 2);

  const same = planUpgrade({ apps: w.apps, id: 'a', fromVersion: 1, toVersion: 2 });
  assert.equal(same.kind, UPGRADE_KINDS.BYTE_SWAP, `契约版没变 ⇒ 不该请 AI：${JSON.stringify(same)}`);
  assert.equal(same.rewrite, false);
  assert.match(same.why, /不请 AI/);

  const changed = planUpgrade({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 3 });
  assert.equal(changed.kind, UPGRADE_KINDS.AI_REWRITE, `契约版变了 ⇒ 必须请 AI：${JSON.stringify(changed)}`);
  assert.equal(changed.rewrite, true);
  assert.match(changed.why, /变了/);

  // ★ 负向对照反过来也成立：把"变了"那一版的号**改回去** ⇒ 同一对版本变成"换字节"
  setSchema(w, 'a', 3, 1);
  const backAgain = planUpgrade({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 3 });
  assert.equal(backAgain.kind, UPGRADE_KINDS.BYTE_SWAP, '号改回去 ⇒ 结论必须跟着回去（不是缓存的）');
});

// ════════════════════════════════════════════════════════════════
// D2 · 重写计数：未变 ⇒ 0；变了 ⇒ > 0
// ════════════════════════════════════════════════════════════════

test('🔴 D2：契约版未变 ⇒ **重写计数 = 0**；★ 负向对照：变了 ⇒ 计数 > 0', () => {
  const w = threeVersions('D2');
  const book = new UpgradeBook({ dir: w.dir });

  // 契约版没变的那一次升级
  const p1 = book.plan({ apps: w.apps, id: 'a', fromVersion: 1, toVersion: 2 });
  assert.equal(p1.kind, UPGRADE_KINDS.BYTE_SWAP);
  assert.equal(book.rewriteCount(), 0, '🔴 契约版没变却涨了重写计数 ⇒ 判据红');

  // ★ 负向对照：契约版变了的那一次 ⇒ 计数必须涨
  const p2 = book.plan({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 3 });
  assert.equal(p2.kind, UPGRADE_KINDS.AI_REWRITE);
  assert.ok(book.rewriteCount() > 0, '契约版变了 ⇒ 重写计数必须 > 0');

  const c = book.counts();
  assert.equal(c.rewrite, 1);
  assert.equal(c.byteSwap, 1);
});

// ════════════════════════════════════════════════════════════════
// D3 · 判定只有一处（源码级）
// ════════════════════════════════════════════════════════════════

test('🔴 D3：判定**只有一处**（那条比较与那个结论全仓各只一份）', () => {
  const files = nodeFs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
  const read = (f) => nodeFs.readFileSync(nodePath.join(SRC, f), 'utf8');
  const whole = files.map((f) => read(f)).join('\n');
  const n = (re) => (whole.match(re) ?? []).length;

  assert.equal(n(/export function decideUpgrade\(/g), 1, '升级判定本体必须只有一份');
  assert.equal(n(/contractFrom === contractTo/g), 1, '那条比较全仓只许一处');
  assert.equal(n(/: UPGRADE_KINDS\.AI_REWRITE;/g), 1, '"请 AI"这个结论只许从那一处出');
  assert.equal(n(/AI_REWRITE: 'ai-rewrite'/g), 1, '"ai-rewrite"这个取值只许定义一次');

  const up = read('app-upgrade.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.equal((up.match(/decideUpgrade\(/g) ?? []).length, 2, '本体一处 ＋ `planUpgrade` 调它一次');
  const at = up.indexOf('export function planUpgrade(');
  assert.ok(at > 0 && /decideUpgrade\(/.test(up.slice(at, at + 2600)), '`planUpgrade` 必须走那一处判定');
  // 粒度默认值只定义一处
  assert.equal(n(/DEFAULT_UPGRADE_MODE = /g), 1);
  assert.equal(n(/UPGRADE_POLICY_FILENAME = /g), 1);
});

// ════════════════════════════════════════════════════════════════
// D4 · 粒度：默认按用户跟；留旧版看得见
// ════════════════════════════════════════════════════════════════

test('🔴 D4：默认**按用户整体跟**；★ 负向对照：显式留旧版的那一个 ⇒ 不跟，且状态看得见', () => {
  const w = threeVersions('D4');
  const policy = new UpgradePolicy({ dir: w.dir });
  assert.equal(policy.snapshot().mode, DEFAULT_UPGRADE_MODE, '默认粒度必须"按用户"');
  assert.equal(policy.state('a').follows, true, '默认跟');
  assert.equal(policy.pinnedVersion('a'), null);

  // 默认那一次：跟 ⇒ 契约版变了就请 AI
  const followsPlan = planUpgrade({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 3, policy });
  assert.equal(followsPlan.kind, UPGRADE_KINDS.AI_REWRITE);
  assert.equal(followsPlan.follows, true);

  // ★ 显式留旧版 ⇒ 它**不跟**（哪怕契约版变了、哪怕别人都在跟）
  policy.pin('a', 2);
  const st = policy.state('a');
  assert.equal(st.follows, false, '留了旧版就必须不跟');
  assert.equal(st.pinnedVersion, 2, '留在哪一版要看得出来');
  assert.equal(st.mode, DEFAULT_UPGRADE_MODE, '粒度本身还是"按用户"（只是这一个被留下了）');
  const held = planUpgrade({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 3, policy });
  assert.equal(held.kind, UPGRADE_KINDS.HELD);
  assert.equal(held.rewrite, false, '留旧版 ⇒ 当然不请 AI');
  assert.match(held.why, /留旧版/);

  // ★ 别的 app 照旧跟（"按用户"不等于"所有人一起冻住"）
  make(w, 'b');
  assert.equal(policy.state('b').follows, true, '没被留下的那一个照旧跟');

  // 跟上 ⇒ 回到默认
  policy.unpin('a');
  assert.equal(policy.state('a').follows, true);
  assert.equal(policy.state('a').pinnedVersion, null);
  const again = planUpgrade({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 3, policy });
  assert.equal(again.kind, UPGRADE_KINDS.AI_REWRITE);
});

// ════════════════════════════════════════════════════════════════
// D5 · 不过度：没有升级需求 ⇒ 一个字节都不写
// ════════════════════════════════════════════════════════════════

test('🔴 D5：**不过度** —— 没有升级需求（没有新版 / 就是这一版）⇒ 一个字节都不写', () => {
  const w = threeVersions('D5');
  const before = treeSha(w.dir);
  const book = new UpgradeBook({ dir: w.dir });

  const same = book.plan({ apps: w.apps, id: 'a', fromVersion: 2, toVersion: 2 });
  assert.equal(same.kind, UPGRADE_KINDS.NONE, `就是这一版 ⇒ 没有升级需求：${JSON.stringify(same)}`);
  assert.equal(book.entries().length, 0, '账本必须还是空的');
  assert.equal(nodeFs.existsSync(book.file), false, '没有升级需求 ⇒ 连账本文件都不许建');
  assert.equal(treeSha(w.dir), before, '整棵树必须逐文件不变');

  // 还有：上游没有新版（不给 toVersion）⇒ 同样什么都不做
  const noNew = book.plan({ apps: w.apps, id: 'a', fromVersion: 2 });
  assert.equal(noNew.kind, UPGRADE_KINDS.NONE);
  assert.equal(treeSha(w.dir), before);

  // ★ 负向对照：真有一次升级需求 ⇒ 账本必须**真的**写一行（证明上面不是恒等空跑）
  book.plan({ apps: w.apps, id: 'a', fromVersion: 1, toVersion: 2 });
  assert.equal(book.entries().length, 1);
  assert.notEqual(treeSha(w.dir), before, '真有升级 ⇒ 必须留痕（对照）');
});

// ════════════════════════════════════════════════════════════════
// D6 · 读不出契约版 ⇒ 不猜
// ════════════════════════════════════════════════════════════════

test('🔴 D6：契约版**读不出来 ⇒ 不猜**（抛 `不可算`），不许默认请一次 AI、也不许默认不请', () => {
  assert.ok(caught(() => decideUpgrade({ contractFrom: null, contractTo: 1 })) instanceof UpgradeError);
  assert.ok(caught(() => decideUpgrade({ contractFrom: 1, contractTo: undefined })) instanceof UpgradeError);
  assert.ok(caught(() => decideUpgrade({})) instanceof UpgradeError);

  const w = world('D6');
  make(w, 'a');
  const gone = caught(() => planUpgrade({ apps: w.apps, id: 'a', fromVersion: 1, toVersion: 99 }));
  assert.ok(gone instanceof UpgradeError, `读不出目标那一版的契约号 ⇒ 必须抛：${gone}`);

  // 粒度那份坏了 ⇒ 也不许猜（宁可说算不出）
  const policy = new UpgradePolicy({ dir: w.dir });
  policy.pin('a', 1);
  nodeFs.writeFileSync(nodePath.join(w.dir, 'upgrade-policy.json'), '{ 这不是 JSON');
  assert.ok(caught(() => policy.follows('a')) instanceof UpgradeError, '坏掉的粒度文件 ⇒ 不许当成"跟"');
});
