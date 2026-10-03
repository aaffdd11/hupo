// **数据契约：命名空间隔离**（`D4.24` · **D1** · 2026-10-03 主人定）—— 离线判据。
//
// 事实与理由见 `docs/dev/166-DATA-CONTRACT.md`；闸脚本 `scripts/check-data-contract.sh`。
//
// 这一份钉六件（每条都带**负向对照**）：
//   D1 契约＝声明：要取的那一格没被声明 ⇒ 拒（fail-closed，理由点名哪一格）；补上 ⇒ 过
//   D2 命名空间隔离：同 app 跨 pack 取 ⇒ 拒；自己取自己 ⇒ 过
//   D3 跨 app 隔离：两个方向都拒；同一个 app 自己的数据照旧读得到
//   D4 越界尝试零残留（逐文件 sha256 复原）；合法写**真的**改动盘（对照不是空跑）
//   D5 规则只住一处（源码级：guard 只一份、三条路都走它、格名与包名形状不另抄）
//   D6 不过度拒：没有数据格的 app 照旧打包；干净只读的场景照旧通

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { Apps } from '../src/apps.js';
import { AppWorkspaces, snapshotWorkspace } from '../src/workspace.js';
import {
  DATA_SHAPE_FILENAME,
  buildDataShape,
} from '../src/data-shape.js';
import {
  DataNamespaceError,
  adjudicateDataAccess,
  dataNamespaceList,
  dataNamespaceRead,
  dataNamespaceWrite,
  resolveDataNamespace,
} from '../src/data-namespace.js';

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { nodeFs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
});
const tmp = () => {
  const d = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-ns-'));
  tmpDirs.push(d);
  return d;
};

const KEYS = [{ name: 'id', type: 'string', null: 'never', dedup: true }];
const shapeText = (packs = ['news']) => JSON.stringify(
  buildDataShape(packs.map((pack) => ({ pack, keys: KEYS }))),
);

const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };

/** 一个世界：制品库 ＋ 工作区，同一个根。 */
function world(tag = 'w') {
  const dir = tmp();
  return { dir, tag, apps: new Apps({ dir, sub: 'u1' }), workspaces: new AppWorkspaces({ dir, log: () => {} }) };
}

/** 一间房：声明（可选）＋ 数据格（值）。 */
function buildScope(w, { id = 'mall', packs = ['news'], declare = true, values = {} } = {}) {
  w.workspaces.ensure(id, { title: id, entry: 'index.html' });
  w.workspaces.write(id, {
    'index.html': `<!doctype html><p>${id}</p>`,
    ...(declare ? { [DATA_SHAPE_FILENAME]: shapeText(packs) } : {}),
  });
  for (const [pack, rel, text] of values) {
    const cell = nodePath.join(w.workspaces.dirFor(id), '.data', pack);
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(cell, rel)), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(cell, rel), text);
  }
  return { id };
}

/** 整棵树逐文件 sha256（判"零残留"用）。 */
function treeSha(root) {
  const out = [];
  const walk = (rel) => {
    let entries = [];
    try { entries = nodeFs.readdirSync(rel === '' ? root : nodePath.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { out.push(`${next}/`); walk(next); continue; }
      const h = nodeCrypto.createHash('sha256')
        .update(nodeFs.readFileSync(nodePath.join(root, next))).digest('hex');
      out.push(`${next}:${h}`);
    }
  };
  walk('');
  return out.join('\n');
}

// ════════════════════════════════════════════════════════════════
// D1 · 契约＝声明：没声明 ⇒ 拒（fail-closed，理由看得见）
// ════════════════════════════════════════════════════════════════

test('🔴 D1：要取的那一格没被声明 ⇒ 拒（理由点名哪一格）；补上声明 ⇒ 过', () => {
  const w = world('D1');
  buildScope(w, { id: 'mall', declare: false, values: [['news', 'rows.json', '{"id":"a"}']] });
  // `data-shape.json` 不在 ⇒ 但 `.data/news/` 在盘上
  for (const route of [
    () => dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'rows.json' }),
    () => dataNamespaceWrite({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'x.json', content: 'x' }),
    () => dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'news' }),
  ]) {
    const err = caught(route);
    assert.ok(err instanceof DataNamespaceError, `🔴 没声明必须拒（fail-closed）：${err?.name}`);
    assert.match(err.message, /news/, '拒绝理由要点名是哪一格');
    assert.match(err.message, /data-shape\.json/, '拒绝理由要点名缺的是哪份声明');
  }
  // **负向对照**：补上一份**只写形状**的声明 ⇒ 过
  w.workspaces.write('mall', { [DATA_SHAPE_FILENAME]: shapeText(['news']) });
  const read = dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'rows.json' });
  assert.equal(read.content.toString('utf8'), '{"id":"a"}', '补上声明之后要真读得到');
  // **负向对照二**：声明里没有的那一包，照旧拒（不是"有声明就全放"）
  const other = caught(() => dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'weather' }));
  assert.ok(other instanceof DataNamespaceError, '声明里没有的那一包也要拒');
});

// ════════════════════════════════════════════════════════════════
// D2 · 命名空间隔离：同 app 跨 pack ⇒ 拒
// ════════════════════════════════════════════════════════════════

test('🔴 D2：同一个 app 里，一个包取不到另一个包的数据（自己取自己 ⇒ 过）', () => {
  const w = world('D2');
  buildScope(w, {
    id: 'mall', packs: ['news', 'weather'],
    values: [['news', 'rows.json', '新闻的值'], ['weather', 'rows.json', '天气的值']],
  });
  // 跨包：news 的调用方去取 weather ⇒ 三条路都拒
  for (const route of [
    () => dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'weather', rel: 'rows.json', callerPack: 'news' }),
    () => dataNamespaceWrite({ workspaces: w.workspaces, id: 'mall', pack: 'weather', rel: 'x', content: 'x', callerPack: 'news' }),
    () => dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'weather', callerPack: 'news' }),
  ]) {
    const err = caught(route);
    assert.ok(err instanceof DataNamespaceError, `🔴 同 app 跨 pack 必须拒：${err?.name}`);
    assert.match(err.message, /跨命名空间/, '理由要说清是跨命名空间，不是别的');
  }
  // 反向也拒：weather 的调用方去取 news
  assert.ok(
    caught(() => dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'rows.json', callerPack: 'weather' }))
      instanceof DataNamespaceError,
    '反向（weather → news）同样拒',
  );
  // **负向对照**：自己取自己 ⇒ 过，而且拿到的是**自己那一格**的值
  const read = dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'rows.json', callerPack: 'news' });
  assert.equal(read.content.toString('utf8'), '新闻的值', '自己取自己要读到自己那一格');
  assert.match(read.dir, /\/\.data\/news$/, '落点必须是自己那一格');
  // 不给 callerPack 时默认 = 自己（自己取自己不需要自报家门）
  assert.equal(dataNamespaceRead({ workspaces: w.workspaces, id: 'mall', pack: 'news', rel: 'rows.json' }).bytes > 0, true);
});

// ════════════════════════════════════════════════════════════════
// D3 · 跨 app 隔离：两个方向都拒
// ════════════════════════════════════════════════════════════════

test('🔴 D3：另一个 app 取不到这个 app 的 `.data/`（两个方向都拒；自己那份照旧读得到）', () => {
  const w = world('D3');
  buildScope(w, { id: 'aaa', values: [['news', 'rows.json', 'aaa 的值']] });
  buildScope(w, { id: 'bbb', values: [['news', 'rows.json', 'bbb 的值']] });
  // 方向一：bbb 的调用方去取 aaa
  const e1 = caught(() => dataNamespaceRead({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'rows.json', callerId: 'bbb', callerPack: 'news' }));
  assert.ok(e1 instanceof DataNamespaceError, `🔴 跨 app 必须拒（bbb→aaa）：${e1?.name}`);
  assert.match(e1.message, /跨 app/, '理由要说清是跨 app');
  // 方向二：aaa 的调用方去取 bbb
  const e2 = caught(() => dataNamespaceWrite({ workspaces: w.workspaces, id: 'bbb', pack: 'news', rel: 'x', content: 'x', callerId: 'aaa', callerPack: 'news' }));
  assert.ok(e2 instanceof DataNamespaceError, `🔴 跨 app 必须拒（aaa→bbb）：${e2?.name}`);
  // **负向对照**：同一个 app 自己的数据照旧读得到（不是"一律拒"）
  assert.equal(
    dataNamespaceRead({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'rows.json' }).content.toString('utf8'),
    'aaa 的值',
  );
  assert.equal(
    dataNamespaceRead({ workspaces: w.workspaces, id: 'bbb', pack: 'news', rel: 'rows.json' }).content.toString('utf8'),
    'bbb 的值',
  );
});

// ════════════════════════════════════════════════════════════════
// D4 · 越界尝试零残留（逐文件 sha256 复原）
// ════════════════════════════════════════════════════════════════

test('🔴 D4：越界尝试盘上零残留（逐文件 sha256 复原）；合法写真的改动盘（对照不是空跑）', () => {
  const w = world('D4');
  buildScope(w, { id: 'aaa', packs: ['news'], values: [['news', 'rows.json', 'aaa 的值']] });
  buildScope(w, { id: 'bbb', packs: ['news'], values: [['news', 'rows.json', 'bbb 的值']] });
  const before = treeSha(w.dir);
  // 一堆越界尝试：跨 app 读／写、跨包读／写、越界相对路径
  const attempts = [
    () => dataNamespaceRead({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'rows.json', callerId: 'bbb' }),
    () => dataNamespaceWrite({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'sneak.json', content: 'x', callerId: 'bbb' }),
    () => dataNamespaceWrite({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'deep/sneak.json', content: 'x', callerPack: 'weather' }),
    () => dataNamespaceRead({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: '../../bbb/.data/news/rows.json' }),
    () => dataNamespaceWrite({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: '../escape.json', content: 'x' }),
  ];
  const kinds = attempts.map((fn) => caught(fn));
  assert.equal(kinds.every((e) => e instanceof DataNamespaceError || e instanceof Error), true, '越界尝试都要抛');
  assert.equal(kinds.every((e) => e !== null), true, '每一条越界尝试都必须真的被拒');
  const after = treeSha(w.dir);
  assert.equal(after, before, '🔴 越界尝试之后整棵树逐文件 sha256 必须逐字复原（零残留）');
  assert.equal(nodeFs.existsSync(nodePath.join(w.workspaces.dirFor('aaa'), '.data', 'news', 'sneak.json')), false);
  assert.equal(nodeFs.existsSync(nodePath.join(w.workspaces.dirFor('bbb'), '.data', 'news', 'escape.json')), false);
  // **负向对照**：合法写**真的**改动盘（证明上面那条比较不是恒等空跑）
  dataNamespaceWrite({ workspaces: w.workspaces, id: 'aaa', pack: 'news', rel: 'ok.json', content: 'ok' });
  assert.notEqual(treeSha(w.dir), before, '★ 对照：合法写必须真的改变盘（否则"零残留"是空话）');
});

// ════════════════════════════════════════════════════════════════
// D5 · 规则只住一处（源码级）
// ════════════════════════════════════════════════════════════════

test('🔴 D5：命名空间那道判定只在 `data-namespace.js` 一处；三条路都走它，别处零重抄', () => {
  const srcDir = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = nodeFs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
  const read = (f) => nodeFs.readFileSync(nodePath.join(srcDir, f), 'utf8');
  const whole = files.map(read).join('\n');
  const count = (re) => (whole.match(re) ?? []).length;

  // 判定本体与解析口各只有一份
  assert.equal(count(/export function adjudicateDataAccess\(/g), 1, '边界判定只许有一份');
  assert.equal(count(/export function resolveDataNamespace\(/g), 1, '命名空间解析口只许有一份');
  // 那两句比较**只在那一份**里（别处抄一遍就是"规则两处"）
  assert.equal(count(/callerApp !== targetApp/g), 1, '`callerApp !== targetApp` 只许出现在那一处');
  assert.equal(count(/callerPack !== targetPack/g), 1, '`callerPack !== targetPack` 只许出现在那一处');
  // 三条路都在 `data-namespace.js` 里，而且各自只**调**那个解析口
  const nsSrc = read('data-namespace.js');
  for (const fn of ['dataNamespaceRead', 'dataNamespaceWrite', 'dataNamespaceList']) {
    assert.match(nsSrc, new RegExp(`export function ${fn}\\(`), `${fn} 要在 data-namespace.js 里`);
    const body = nsSrc.slice(nsSrc.indexOf(`export function ${fn}(`));
    assert.match(body.slice(0, 900), /resolveDataNamespace\(/, `${fn} 必须走那一个解析口`);
  }
  // 格名与包名形状**复用**，不另抄
  assert.match(nsSrc, /from '\.\/outbound\.js'/, '格名要从 outbound.js 取');
  assert.match(nsSrc, /DATA_DIRNAME/, '格名用 DATA_DIRNAME，不许写字面 `.data`');
  assert.match(nsSrc, /checkPackName/, '包名形状用 data-shape.checkPackName，不许再写一个正则');
  assert.equal(count(/DATA_DIRNAME = /g), 1, '格名只许定义一处（outbound.js）');
  // 那份固定名文件的名字也只许在 data-shape.js 写一次（照 D4 那条）
  assert.deepEqual(
    files.filter((f) => read(f).includes("'data-shape.json'")),
    ['data-shape.js'],
    '固定名只许在 data-shape.js 写一次',
  );
});

// ════════════════════════════════════════════════════════════════
// D6 · 不过度拒
// ════════════════════════════════════════════════════════════════

test('🔴 D6：没有数据格的 app 照旧打包；干净只读的场景照旧通（不许"一律拒"）', () => {
  const w = world('D6');
  // 一点数据格都没有的那一份：照旧打包得住（这一侧的闸不碰它）
  w.workspaces.ensure('plain', { title: '素', entry: 'index.html' });
  w.workspaces.write('plain', { 'index.html': '<p>没有数据</p>' });
  const snap = snapshotWorkspace({ apps: w.apps, workspaces: w.workspaces, id: 'plain', title: '素', icon: 'dice' });
  assert.equal(snap.shape.refused.length, 0, '没有数据格 ⇒ 不拦');
  assert.equal(snap.shape.declared, false, '如实记"没有声明"');
  // 干净只读：声明了、放着值 ⇒ 读得到、列得到；列两次结果一致（读没有副作用）
  buildScope(w, { id: 'mall', values: [['news', 'rows.json', '值']] });
  const first = dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'news' });
  const second = dataNamespaceList({ workspaces: w.workspaces, id: 'mall', pack: 'news' });
  assert.deepEqual(first.files, ['rows.json']);
  assert.deepEqual(second.files, first.files, '读一遍不许改变盘上的事实');
  // 直接问那次判定本身：自己取自己 ⇒ 过（不是"一律拒"）
  assert.equal(adjudicateDataAccess({ callerApp: 'mall', callerPack: 'news', targetApp: 'mall', targetPack: 'news' }).app, 'mall');
  // 解析出来的落点永远在**它自己**那一间房里
  const ns = resolveDataNamespace({ workspaces: w.workspaces, id: 'mall', pack: 'news' });
  assert.equal(ns.dir, nodePath.join(w.workspaces.dirFor('mall'), '.data', 'news'));
});
