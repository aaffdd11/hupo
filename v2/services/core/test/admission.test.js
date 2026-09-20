// **准入闸**（手册 `08-SPEC.md` **§9.1** / **§10.3**）。
//
// ⚠️ 这一份的两个重点：
//
//   1. **判据是"比"，而且分子分母必须同层。**
//      拿我们的 `memory.current` 去除以祖先的 `memory.max`，会算出一个偏小的比
//      ⇒ **在最该拒的那一刻放行**。所以 `findLimit` 走到哪一层，就在那一层取两个数。
//
//   2. **算不出来 ≠ 放行。**
//      实测这台机器（`dsh-subprocess-*.scope`）从自己到 `/user.slice`
//      **每一层都是 `max`** ⇒ 手册那个 0.75 无从谈起。
//      这种情况必须有一句**没算出来**的明确说法（横幅里，
//      与完整性清单的"还没启用"同一个套路）：**"看起来有闸、其实没有"比没有闸更坏。**

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';

import {
  ADMIT_RATIO,
  cgroupPathFrom,
  decide,
  describeAdmission,
  findLimit,
  readAdmission,
} from '../src/admission.js';

const MB = 1024 * 1024;

/** 造一棵假 cgroup 树；`levels` 从**外层往里**给（最后一个是"我们"那一层）。 */
function fakeCgroup(levels) {
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-cg-'));
  let prev = root;
  const paths = [];
  for (const lv of levels) {
    const dir = nodePath.join(prev, lv.name);
    nodeFs.mkdirSync(dir, { recursive: true });
    if (lv.max !== undefined) nodeFs.writeFileSync(nodePath.join(dir, 'memory.max'), lv.max);
    if (lv.current !== undefined) nodeFs.writeFileSync(nodePath.join(dir, 'memory.current'), lv.current);
    paths.push(dir);
    prev = dir;
  }
  return { root, paths, readFile: (f) => {
    try {
      return nodeFs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  } };
}

test('cgroup 路径：从 /proc/<pid>/cgroup 的内容里取 v2 那行', () => {
  assert.equal(
    cgroupPathFrom('0::/user.slice/user-1001.slice/app.slice/x.scope\n'),
    '/user.slice/user-1001.slice/app.slice/x.scope',
  );
  // v1 那种多行格式：只认 `0::` 那条
  assert.equal(cgroupPathFrom('11:memory:/old/style\n0::/a/b\n'), '/a/b');
  assert.equal(cgroupPathFrom('乱七八糟'), null);
});

test('🔴 分子分母必须**同层**：谁有上限，就在谁那层取 current', () => {
  const { paths, readFile, root } = fakeCgroup([
    { name: 'user.slice', max: 'max', current: '999999999' },
    { name: 'app.slice', max: String(640 * MB), current: String(300 * MB) },
    { name: 'x.scope', max: 'max', current: String(100 * MB) },
  ]);
  try {
    const found = findLimit({ start: paths[2], readFile });
    assert.equal(found.limitBytes, 640 * MB);
    assert.equal(found.usedBytes, 300 * MB, '分子要取**有上限那一层**的 current，不是我们自己的');
    assert.equal(found.level, paths[1]);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test('往上找，直到找到第一个有限上限', () => {
  const { paths, readFile, root } = fakeCgroup([
    { name: 'a', max: 'max', current: '1' },
    { name: 'b', max: String(1024 * MB), current: String(10 * MB) },
    { name: 'c', max: 'max', current: '2' },
    { name: 'd', max: 'max', current: '3' },
  ]);
  try {
    const found = findLimit({ start: paths[3], readFile });
    assert.equal(found.limitBytes, 1024 * MB);
    assert.equal(found.level, paths[1], '最近的**有上限**那一层');
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test('🔴 全都没有上限 ⇒ 如实报"算不出判据"，**不许**悄悄当成"放行"', () => {
  const { paths, readFile, root } = fakeCgroup([
    { name: 'user.slice', max: 'max', current: '1' },
    { name: 'x.scope', max: 'max', current: '2' },
  ]);
  try {
    const adm = decide(findLimit({ start: paths[1], readFile }));
    assert.equal(adm.code, 'no-limit');
    assert.equal(adm.ok, true, '放行（服务得能跑）……');
    const line = describeAdmission(adm);
    assert.match(line, /算不出判据/, '……但横幅上必须**说出来**');
    assert.match(line, /不生效/);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test('🔴 到了 0.75 就拒（是 ≥，不是 >）', () => {
  assert.equal(ADMIT_RATIO, 0.75, '这个数字来自手册 §9.1/§10.3，改它要先改手册');
  assert.equal(decide({ limitBytes: 1000, usedBytes: 749 }).ok, true);
  assert.equal(decide({ limitBytes: 1000, usedBytes: 750 }).ok, false, '750/1000 = 恰好 0.75 ⇒ 拒');
  assert.equal(decide({ limitBytes: 1000, usedBytes: 999 }).code, 'busy');
  assert.equal(decide({ limitBytes: null, usedBytes: 1 }).code, 'no-limit');
  assert.equal(decide({ limitBytes: 0, usedBytes: 0 }).code, 'no-limit', '0/NaN 都算"算不出来"');
});

test('describeAdmission：有上限时要说清上限和现在多少', () => {
  const line = describeAdmission({ code: 'ok', limitBytes: 640 * MB, usedBytes: 160 * MB, ratio: 0.25 });
  assert.match(line, /上限 640M/);
  assert.match(line, /75%/);
  assert.match(line, /现在 25%/);
});

test('readAdmission：真读这台机器也不许抛（读不到就当"算不出来"）', () => {
  const adm = readAdmission({ pid: 999999, readProc: () => null, readFile: () => null });
  assert.equal(adm.code, 'no-limit');
  // 用真的 /proc 自己读一遍：不管有没有上限，都不许抛
  const real = readAdmission();
  assert.ok(['ok', 'no-limit', 'busy'].includes(real.code), `拿到 ${JSON.stringify(real)}`);
});
