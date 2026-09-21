// **盒子里放一把钥匙**（契约 `docs/dev/46-KEY-DELIVERY.md` §三.1）。
//
// ⚠️ 这一组钉两件：① 它写的是**哪一个路径**（卷里那个 —— 重建容器不丢是这一篇存在的理由）；
//    ② 坏输入一律拒（空 / 不可打印 / 超长），而且**拒的时候什么都不写**。

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import test from 'node:test';
import { adoptKeyFile, LEGACY_TMPFS_KEY_FILE } from '../src/key-path.mjs';
import { keyFileFor, putKey } from '../src/put-key.mjs';
import { KEY_FIELD } from '../src/tenant-shell.mjs';

const tmp = () => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-putkey-'));

test('🔴 钥匙住**卷里**（不是 tmpfs）—— 这是"重建容器不丢"那条的落点', () => {
  assert.equal(keyFileFor({ HUPO_DATA: '/data' }), '/data/creds.yaml');
  // 🔴 **旧名字（`HUPO_KEY_FILE`）要被忽略** —— 2026-09-21 真机当场栽的：
  //    镜像里那条 env 指的是 tmpfs，而 `podman exec` 起来的进程拿不到入口那次覆盖
  //    ⇒ 认它就会写回 tmpfs（"放好了"，然后重建容器照样丢）。
  assert.equal(keyFileFor({ HUPO_DATA: '/data', HUPO_KEY_FILE: '/run/hupo/creds.yaml' }), '/data/creds.yaml');
  // 显式给了**新名字**就听它（留一个口子：判据 / 将来换布局）
  assert.equal(keyFileFor({ HUPO_DATA: '/data', HUPO_KEY_PATH: '/x/y.yml' }), '/x/y.yml');
  // ⚠️ 兜底也不许落回 tmpfs（`/run` 是每次重建都没的）
  assert.ok(!keyFileFor({}).startsWith('/run/'), '兜底不能是 /run');
});

test('写下去：文件在、内容是那一行、权限 0600（**原子写**）', () => {
  const dir = tmp();
  const file = nodePath.join(dir, 'creds.yaml');
  const r = putKey({ raw: '  sk-abc123  \n', keyFile: file });
  assert.deepEqual(r, { ok: true, file });
  assert.equal(nodeFs.readFileSync(file, 'utf8'), `${KEY_FIELD}: sk-abc123\n`);
  assert.equal(nodeFs.statSync(file).mode & 0o777, 0o600);
  assert.equal(nodeFs.existsSync(`${file}.tmp`), false, '临时文件不该留下');
});

test('🔴 坏输入一律拒，而且**什么都不写**（不许留下半个文件）', () => {
  const dir = tmp();
  const file = nodePath.join(dir, 'creds.yaml');
  for (const raw of ['', '   \n', 'sk-x\u0007y', 'sk-中文', 'x'.repeat(5000)]) {
    const r = putKey({ raw, keyFile: file });
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.ok(r.why.length > 0, '要说清为什么');
    assert.equal(nodeFs.existsSync(file), false, '拒的时候一个字节都不该留下');
  }
});

test('🔴 `tenant-shell` 的写入路径**默认就走那条规则**（调用方不给也不会写错地方）', () => {
  // ⚠️ 2026-09-21 真机连栽两层：入口把**镜像里那条旧 env**（tmpfs）传给了 `watchForKey`
  //    ⇒ 容器日志说"拿到凭据了"，而**卷里没有那个文件**（重建容器照样丢）。
  const src = nodeFs.readFileSync(new URL('../src/tenant-shell.mjs', import.meta.url), 'utf8');
  assert.match(src, /keyFile = adoptKeyFile\(\)/, '两个函数的默认值都要走 key-path.mjs');
  assert.ok(!/HUPO_KEY_FILE/.test(src.replace(/^\s*\/\/.*$/gmu, '')), '非注释行里不许再出现旧 env 名');
});

test('⚠️ 写不进去要**如实说**（不是假装成功）', () => {
  const fakeFs = {
    writeFileSync() {
      const e = new Error('nope');
      e.code = 'EACCES';
      throw e;
    },
    chmodSync() {},
    renameSync() {},
  };
  const r = putKey({ raw: 'sk-x', keyFile: '/nope/creds.yaml', fs: fakeFs });
  assert.equal(r.ok, false);
  assert.match(r.why, /EACCES/);
});

test('🔴 旧入口显式传进来的那条 tmpfs 路径**说了不算**（产品层的规则说了算）', () => {
  // ⚠️ 2026-09-21 真机连栽两层，第二层就是这个：镜像里的旧入口把
  //    `keyFile: '/run/hupo/creds.yaml'` 传给了 `watchForKey`，而"显式优先"
  //    把规则顶掉 ⇒ 钥匙写进 tmpfs ⇒ 容器日志说"拿到凭证了"，卷里却没有那个文件。
  assert.equal(adoptKeyFile(LEGACY_TMPFS_KEY_FILE, { HUPO_DATA: '/data' }), '/data/creds.yaml');
  assert.equal(adoptKeyFile('', { HUPO_DATA: '/data' }), '/data/creds.yaml');
  assert.equal(adoptKeyFile(undefined, { HUPO_DATA: '/data' }), '/data/creds.yaml');
  // 但**别的**显式值是算数的（测试与将来换布局都要这个口子）
  assert.equal(adoptKeyFile('/tmp/other.yml', { HUPO_DATA: '/data' }), '/tmp/other.yml');
});
