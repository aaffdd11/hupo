// **产品层**（契约 `docs/dev/45-TENANT-UPDATE.md`）——
// 那一句"这一台跑的是哪一版、要不要叫它重开"的判据。
//
// ⚠️ 这一组测的全是**纯函数**与"拿假 fs 喂它"，不碰真机器。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';
import {
  FALLBACK_BUILD,
  compareTenantBuild,
  createNagBook,
  planRollout,
  readProductLayer,
} from '../src/product-layer.js';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-code-'));

/** 造一个假的产品层目录：<root>/<fp>/manifest.json + <root>/current → <fp>。 */
function fakeRoot({ fp = 'abc123abc123', manifest = true, link = true } = {}) {
  const root = tmp();
  if (fp !== null) {
    nodeFs.mkdirSync(nodePath.join(root, fp), { recursive: true });
    if (manifest) {
      nodeFs.writeFileSync(
        nodePath.join(root, fp, 'manifest.json'),
        JSON.stringify({ fingerprint: fp, builtAt: '2026-09-21T00:00:00.000Z', gitRev: 'deadbee' }),
      );
    }
  }
  if (link && fp !== null) nodeFs.symlinkSync(nodePath.join(root, fp), nodePath.join(root, 'current'));
  return root;
}

test('🔴 读得到就是读得到：指纹从 manifest 来，目录是软链解出来的真目录', () => {
  const root = fakeRoot();
  const got = readProductLayer({ root });
  assert.equal(got.fingerprint, 'abc123abc123');
  assert.equal(got.gitRev, 'deadbee');
  assert.equal(got.dir, nodePath.join(root, 'abc123abc123'), '要解掉软链（不然"翻没过"看不出来）');
});

test('🔴 读不到就是 `null`，**不许**猜一个默认值糊过去', () => {
  // ⚠️ **显式给 `mount: null`**：不然这几条会随跑测试那个进程的 `HUPO_CODE_DIR` 变
  //    （盒里跑的时候它是有值的）—— 判据不许依赖环境（"跑一次绿跑一次红"最坏）。
  // ① 压根没翻过
  assert.equal(readProductLayer({ root: fakeRoot({ fp: null }), mount: null }), null);
  // ② 软链在、但那一版里没有 manifest
  assert.equal(readProductLayer({ root: fakeRoot({ manifest: false }), mount: null }), null);
  // ③ 目录都不在
  assert.equal(readProductLayer({ root: nodePath.join(tmp(), '没有这个'), mount: null }), null);
  // ④ manifest 是坏的 JSON
  const root = fakeRoot({ fp: 'badbadbadbad' });
  nodeFs.writeFileSync(nodePath.join(root, 'badbadbadbad', 'manifest.json'), '{不是 JSON');
  assert.equal(readProductLayer({ root, mount: null }), null);
});

test('🔴 盒里那一份也**读得到**（`$HUPO_CODE_DIR`）—— 横幅不许再说"读不到／停在镜像那份兜底上"', () => {
  // 盒里没有 `/srv/hupo/tenant-code`、也没有 `current` 软链；**挂进来的那一份自己**就是那一版。
  // 🔴 修前这里读的是 null ⇒ 盒里的启动横幅写着「读不到产品层（……容器会停在镜像里那份兜底上）」，
  //    而**旁边那一行**就打着 `构建 <指纹>`（两半都是假话，而且那份"兜底"2026-09-23 就没了）。
  const mount = nodePath.join(fakeRoot({ fp: 'boxboxboxbox' }), 'boxboxboxbox');
  const noRoot = nodePath.join(tmp(), '没有这个');
  const got = readProductLayer({ root: noRoot, mount });
  assert.equal(got?.fingerprint, 'boxboxboxbox');
  assert.equal(got?.dir, mount);
  // 宿主那一份在的时候**仍然是它优先**（顺序不许反：宿主才是"该不该叫它重开"的权威）
  const root = fakeRoot({ fp: 'hosthosthost' });
  assert.equal(readProductLayer({ root, mount }).fingerprint, 'hosthosthost');
  // 两处都没有 ⇒ 还是 null（如实说读不到）
  assert.equal(readProductLayer({ root: noRoot, mount: null }), null);
  // 挂上去了、但那一份里没有 manifest ⇒ 也读不到（不许拿一个空壳糊过去）
  assert.equal(readProductLayer({ root: noRoot, mount: tmp() }), null);
});

test('🔴 同一版 ⇒ 不叫它重开（**这一条最要紧**：判错就是每台容器被反复重开）', () => {
  const v = compareTenantBuild({ reported: 'abc123abc123', current: 'abc123abc123' });
  assert.equal(v.verdict, 'same');
  assert.equal(v.reload, false);
});

test('🔴 自报不出产品层版本（`dev` / 空）要认出来，并叫它重开 —— 还要**说清是哪种可能**', () => {
  // ⚠️ **2026-09-23（账 #42）改了这一条**：镜像里那份 `src/` 兜底**已经拿掉**
  //    ⇒ "它跑的是镜像里那份兜底"这个解释**不再成立**（认不到产品层会直接起不来）。
  //    现在这一档的意思是"**它自报不出产品层的版本**"，可能有两种原因，
  //    而那句话必须把两种都说到（挂载没进去 / 那一版里没有 manifest.json）。
  for (const reported of [FALLBACK_BUILD, '', null, undefined]) {
    const v = compareTenantBuild({ reported, current: 'abc123abc123' });
    assert.equal(v.verdict, 'unversioned', `reported=${JSON.stringify(reported)}`);
    assert.equal(v.reload, true);
    assert.match(v.line, /自报不出产品层的版本/, '一句指错方向的话比不说更费时间');
    assert.ok(!/兜底/.test(v.line), '🔴 不许再说"兜底" —— 那份兜底已经拿掉了（说了就是假话）');
    assert.match(v.line, /manifest/, '两种可能之一要说出来');
  }
});

test('另一版（翻过了但它还没重开）⇒ 叫它重开，而且两边指纹都要说出来', () => {
  const v = compareTenantBuild({ reported: 'oldoldoldold', current: 'abc123abc123' });
  assert.equal(v.verdict, 'stale');
  assert.equal(v.reload, true);
  assert.match(v.line, /oldoldoldold/);
  assert.match(v.line, /abc123abc123/);
});

test('🔴 宿主自己读不到当前那一版 ⇒ **谁都不叫**（叫了就是让它们去挂一个不存在的东西）', () => {
  const v = compareTenantBuild({ reported: 'anything', current: null });
  assert.equal(v.verdict, 'unknown');
  assert.equal(v.reload, false, '这一条写反了，就会把每一台容器都弄死');
});

test('⚠️ 变异验证：把"同一版"那条判据改坏（永远说 stale）⇒ 上面第一条必须红', () => {
  // 复制一份实现，只改一处（`===` 换成 `!==`），确认**判据本身**抓得住
  const broken = ({ reported, current }) => {
    const r = typeof reported === 'string' ? reported : '';
    if (!r || r === FALLBACK_BUILD) return { verdict: 'unversioned', reload: true };
    if (r !== current) return { verdict: 'stale', reload: true };
    return { verdict: 'stale', reload: true }; // ← 坏在这里
  };
  const v = broken({ reported: 'abc123abc123', current: 'abc123abc123' });
  assert.equal(v.reload, true, '坏版本确实会说"要重开"');
  const good = compareTenantBuild({ reported: 'abc123abc123', current: 'abc123abc123' });
  assert.equal(good.reload, false, '而真的那一份**必须**说不用');
});

test('🔴 扫描：只挑"该叫它重开"的那几台，而且**读不到当前版本时一台都不挑**', () => {
  const reports = new Map([
    ['hupo-a', 'abc123abc123'], // 就是当前这一版
    ['hupo-b', 'oldoldoldold'], // 旧的
    ['hupo-c', 'dev'], // 自报不出产品层版本的那台
  ]);
  const out = planRollout({ reports, current: 'abc123abc123' });
  assert.deepEqual(out.map((x) => x.tenant).sort(), ['hupo-b', 'hupo-c']);
  assert.equal(out.find((x) => x.tenant === 'hupo-c').verdict, 'unversioned');
  // ⚠️ 宿主自己读不到当前那一版 ⇒ **一台都不挑**（挑了就全弄死）
  assert.deepEqual(planRollout({ reports, current: null }), []);
  assert.deepEqual(planRollout({ reports: null, current: 'abc123abc123' }), []);
});

test('🔴 记账只挡**日志**：同一台 + 同一版只说一次，换一版又能说', () => {
  const nb = createNagBook();
  assert.equal(nb.take('hupo-a', 'v1'), true);
  assert.equal(nb.take('hupo-a', 'v1'), false, '同一件事别每 30 秒喊一遍（真消息会被淹掉）');
  assert.equal(nb.take('hupo-b', 'v1'), true, '另一台是另一件事');
  assert.equal(nb.take('hupo-a', 'v2'), true, '换了版本就该再说一次');
  // 它报上了当前这一版 ⇒ 这台的记录清掉（下一版还要能提醒）
  nb.forget('hupo-a');
  assert.equal(nb.take('hupo-a', 'v2'), true);
});
