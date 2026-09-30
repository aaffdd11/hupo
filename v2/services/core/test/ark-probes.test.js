// **图片/视频那两个真读数探针**自己的判据（`scripts/check-ark-{image,video}.mjs`）。
//
// 为什么探针也要有判据（与 `asr-probe.test.js` 同一个理由）：
//   它们是**唯一会拿真钥匙去问真上游**的那两件东西 —— 它们自己坏了（把钥匙打印出来、
//   或者"没说 --spend 就偷偷花钱"）比没探针更坏。
//
// 守的几条（**一条都不联网**：联网那几档要真钥匙，在这里跑会把闸变成看网络脸色）：
//   ① 干跑（不带 `--spend`）**不用钥匙**就能跑，而且**明说"没有"**
//   ② 🔴 **一个字节的钥匙都不许出现在输出里**
//   ③ 要花钱的那两档（`--spend` / `--preflight`）没钥匙 ⇒ **当场退 3**，不许去连
//   ④ `--help` 打得开
//   ⑤ `--fake` 这一档的措辞必须**说清它能证什么、不能证什么**（火山鉴权在路由之前）
//
// ⚠️ 这里**不验** `--spend` / `--fake` 的真回话 —— 那要真钥匙（`--spend`）或至少要出去一次
//    （`--fake`）。真回话逐字记在 `docs/dev/79-CREDS-TABS.md` §九·补。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const CORE = nodePath.resolve(HERE, '..');
const ROOT = nodePath.resolve(CORE, '..', '..', '..');

const PROBES = [
  { name: '图片', path: nodePath.join(ROOT, 'scripts', 'check-ark-image.mjs'), keyVar: 'ARK_API_KEY' },
  { name: '视频', path: nodePath.join(ROOT, 'scripts', 'check-ark-video.mjs'), keyVar: 'ARK_API_KEY' },
];

/** 跑一次探针：**环境里可能真存在的钥匙一律摘干净**（判据里只许用假凭据）。 */
function run(p, argv = [], extraEnv = {}) {
  const env = { ...process.env };
  for (const k of ['ARK_API_KEY', 'HUPO_IMAGE_KEY', 'HUPO_VIDEO_KEY', 'HUPO_IMAGE_URL', 'HUPO_VIDEO_BASE', 'HUPO_IMAGE_MODEL', 'HUPO_VIDEO_MODEL']) delete env[k];
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [p.path, ...argv], { encoding: 'utf8', env, cwd: ROOT, timeout: 60000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const FAKE_KEY = 'u'.repeat(20) + '-' + 'v'.repeat(12);

for (const p of PROBES) {
  test(`${p.name}① 干跑：不用钥匙就能跑 ⇒ 退 0，而且**明说"没有"**`, () => {
    const r = run(p);
    assert.equal(r.code, 0, `干跑退了 ${r.code}：\n${r.out}`);
    assert.match(r.out, /干跑/, '没写清这是干跑');
    assert.match(r.out, /钥匙 +\*\*没有\*\*/, `没钥匙时没说"没有"：\n${r.out.slice(0, 400)}`);
    assert.match(r.out, /--spend/, '没告诉人怎么真跑');
  });

  test(`${p.name}② 🔴 输出里**一个字符的钥匙都没有**`, () => {
    const r = run(p, [], { [p.keyVar]: FAKE_KEY });
    assert.ok(!r.out.includes(FAKE_KEY), `钥匙漏进输出（${p.name}）`);
    // 只许出现"几个字符"这种长度信息（不是内容）
    assert.match(r.out, new RegExp(`${FAKE_KEY.length} 个字符`), '连长度都不说 ⇒ 人没法确认它读到了钥匙');
  });

  test(`${p.name}③ 要花钱的两档没钥匙 ⇒ **当场退 3**，不去连`, () => {
    for (const argv of [['--spend'], ['--preflight']]) {
      const r = run(p, argv);
      assert.equal(r.code, 3, `${argv[0]} 应当是 3（没给钥匙），实测 ${r.code}：\n${r.out}`);
      assert.match(r.out, /没给钥匙/, `没说清缺什么（${argv[0]}）`);
    }
  });

  test(`${p.name}④ \`--help\` 打得开`, () => {
    const r = run(p, ['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /用法/, '没有用法那一行');
  });

  test(`${p.name}⑤ \`--fake\` 与 \`--preflight\` 的措辞说清"证得了什么"`, () => {
    // ⚠️ 只读**脚本源码**里的说明（不去连）：这两档的意义必须写在用法里，
    //    否则下一个人会以为 `--fake` 验过路径（实际火山鉴权在路由之前 ⇒ 证不了）。
    const src = nodePath.join(ROOT, 'scripts', p.name === '图片' ? 'check-ark-image.mjs' : 'check-ark-video.mjs');
    const t = nodeFs.readFileSync(src, 'utf8');
    assert.match(t, /路由之前/, '没写清"鉴权在路由之前"这一条（`--fake` 的边界）');
    assert.match(t, /不花钱/, '没写清 `--preflight` 不花钱');
    assert.match(t, /--preflight/, '用法里没有 `--preflight`');
    assert.match(t, /--fake/, '用法里没有 `--fake`');
  });
}
