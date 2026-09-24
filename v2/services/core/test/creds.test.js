// **配置页那四样凭据**的判据（P0-2/P0-3 · 契约 `docs/dev/79-CREDS-TABS.md`）。
//
// 主人 2026-09-24 定的形状：*"配置页用来配置模型，语言大模型apikey，
// 语音大模型，图片生成，视频生成。"*
//
// 守的几条：
//   ① 🔴 **值永远不回来**：`/api/space`、`/api/creds` 的回执里只有"有没有"，
//      一个字符的值都不许出去（那条路是密钥）
//   ② 🔴 **顺序陷阱**：盒子那边读文件是"取第一个名字里带 KEY/SECRET 的行"
//      ⇒ 语音密钥写在语言那把前面，**模型那一把就会被换成语音密钥**
//      （现象只是上游鉴权失败，看日志完全看不出原因）⇒ 两道防线都要判
//   ③ **主人那份凭据只许外科式动**：`records`（浏览器会话授权）**逐字节不许变**，
//      而且**先备份、写完自己核、核不过还原**
//   ④ **按人分开存**：一个人的四样不许落到别人那份文件里；`sub` 拼路径要洗
//   ⑤ 语音**三样齐了才算有**（缺一样就是没有）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Auth } from '../src/auth.js';
import {
  CRED_FIELDS,
  CRED_ORDER,
  credStatus,
  credValueOk,
  mergeCreds,
  parseCreds,
} from '../src/creds.mjs';
import { credsFileFor, readUserCreds, writeUserCreds } from '../src/creds-store.js';
import { OWNER_KEY_REF, recordsOf, renderOwnerKey, writeOwnerKey } from '../src/owner-creds.js';
import { parseKey } from '../src/model-proxy.mjs';
import { createServer } from '../src/server.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';

const tmp = (p = 'hupo-creds-') => nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), p));

// ── ① 纯逻辑 ────────────────────────────────────────────────
test('认得出那六行、认不出的原样留着（空值**不算有**）', () => {
  const { values, unknown } = parseCreds([
    '# 注释',
    'HUPO_MODEL_KEY: sk-abc',
    'HUPO_IMAGE_KEY:   img-123  ',
    'HUPO_VOICE_APPID: 1300000001',
    'HUPO_VOICE_SECRET_KEY:',
    'HUPO_VIDEO_KEY: vid-xyz',
    '别人写的: 留着',
  ].join('\n'));
  assert.equal(values.model, 'sk-abc');
  assert.equal(values.image, 'img-123', '两边的空格要去掉');
  assert.equal(values.voiceAppId, '1300000001');
  assert.equal(values.video, 'vid-xyz');
  assert.equal(values.voiceSecretKey, undefined, '★ 空值**不算有**');
  const s = credStatus(values);
  assert.equal(s.model, true);
  assert.equal(s.image, true);
  assert.equal(s.video, true);
  assert.equal(s.voice, false, '★ 语音三样齐了才算有（缺一样就是没有）');
  assert.equal(unknown.includes('别人写的: 留着'), true, '认不出的行要留着（不是我们写的）');
});

test('`credValueOk`：非空 + 只有 ASCII 可打印字符', () => {
  assert.equal(credValueOk('sk-abc'), true);
  assert.equal(credValueOk(''), false);
  assert.equal(credValueOk('有中文'), false);
  assert.equal(credValueOk('a\nb'), false, '换行会把文件写坏');
});

test('🔴 合并：**语言那一把必须写在最前**（旧文件顺序错了也纠正）', () => {
  // 旧文件是"语音在前"（那正是危险形状）
  const old = 'HUPO_VOICE_SECRET_KEY: SK-voice\nHUPO_MODEL_KEY: sk-model\n别人写的: 留着\n';
  const next = mergeCreds(old, { image: 'img-1' });
  const order = next.split('\n').filter((l) => l.includes(':')).map((l) => l.split(':')[0].trim());
  const ours = order.filter((n) => Object.values(CRED_FIELDS).includes(n));
  assert.deepEqual(ours, ['HUPO_MODEL_KEY', 'HUPO_IMAGE_KEY', 'HUPO_VOICE_SECRET_KEY'],
    `★ 我们那几行要按 CRED_ORDER 重排（实际 ${JSON.stringify(order)}）`);
  assert.equal(order[0], '别人写的', '别人的行照留');
  assert.match(next, /HUPO_MODEL_KEY: sk-model/, '没给新值的字段要保住原值');
  assert.match(next, /HUPO_IMAGE_KEY: img-1/);
  assert.equal(next.endsWith('\n'), true, '末尾要有换行');
  assert.deepEqual(CRED_ORDER.slice(0, 1), ['model'], '次序表的头一个就是语言那把');
});

test('合并：给空串 ⇒ **删掉那一行**（不是写一个空值）', () => {
  const next = mergeCreds('HUPO_MODEL_KEY: sk-a\nHUPO_VIDEO_KEY: v\n', { video: '' });
  assert.equal(next.includes('HUPO_VIDEO_KEY'), false);
  assert.match(next, /HUPO_MODEL_KEY: sk-a/);
});

test('🔴 盒子那边读文件：**名字优先**，语音密钥写在前面也抢不走模型那把', () => {
  // 这是那个真陷阱：`parseKey` 原来只按"名字里带 KEY/SECRET 的第一个"取
  const text = [
    'HUPO_VOICE_SECRET_KEY: SK-voice-secret',
    'HUPO_MODEL_KEY: sk-the-real-one',
    'HUPO_IMAGE_KEY: img-1',
  ].join('\n');
  assert.equal(parseKey(text), 'sk-the-real-one',
    '★ 顺序不该决定"哪一把是模型钥匙"（否则会把语音密钥当模型钥匙发出去）');
  // 负向对照：没有 `HUPO_MODEL_KEY` 时，老规矩照旧（取名字带 KEY 的第一个）
  assert.equal(parseKey('HUPO_IMAGE_KEY: img-1\nHUPO_VIDEO_KEY: v'), 'img-1');
  // 老形状（一行`名字: 值`）也不许变
  assert.equal(parseKey('HUPO_MODEL_KEY: sk-only'), 'sk-only');
  // 整份就是一把钥匙（没有冒号）也不许变
  assert.equal(parseKey('sk-bare-key\n'), 'sk-bare-key');
});

// ── ② 按人存档 ──────────────────────────────────────────────
test('按人分开存：写进去读得出来、0600、不留 `.tmp`、**别人的文件不受影响**', () => {
  const dir = tmp();
  try {
    const r1 = writeUserCreds(dir, 'u1', { image: 'img-1', voiceAppId: '1300000001' });
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.status, { model: false, voice: false, image: true, video: false });
    writeUserCreds(dir, 'u2', { video: 'vid-2' });

    const a = readUserCreds(dir, 'u1');
    const b = readUserCreds(dir, 'u2');
    assert.equal(a.values.image, 'img-1');
    assert.equal(a.values.video, undefined, '★ 乙的东西不许出现在甲这儿');
    assert.equal(b.values.video, 'vid-2');
    assert.equal(b.values.image, undefined);

    const file = credsFileFor(dir, 'u1');
    assert.equal(nodeFs.statSync(file).mode & 0o777, 0o600, '凭据文件必须 0600');
    assert.equal(nodeFs.existsSync(`${file}.tmp`), false, '原子写不该留下 .tmp');
    // 再写一次（同一份）⇒ 两样都在（不是整份覆盖掉）
    writeUserCreds(dir, 'u1', { video: 'vid-1' });
    const again = readUserCreds(dir, 'u1');
    assert.equal(again.values.image, 'img-1');
    assert.equal(again.values.video, 'vid-1');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('🔴 `sub` 拼路径要洗：`../` 那类输入**不许**走到文件系统', () => {
  const dir = tmp();
  try {
    for (const bad of ['../evil', 'a/b', '..', '', 'x'.repeat(65), 'a b', '.hidden']) {
      assert.equal(credsFileFor(dir, bad), null, `这个 sub 不该被接受：${bad}`);
    }
    assert.equal(credsFileFor(dir, 'u1').endsWith('/creds/u1.yaml'), true);
    // 负向对照：正常 id 照收
    assert.equal(credsFileFor(dir, 'owner-1_2').length > 0, true);
    // 认不出的 sub ⇒ 写的时候**如实失败**（不许静默不写）
    const r = writeUserCreds(dir, '../evil', { image: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.why, 'bad-sub');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ③ 主人那份凭据：外科式 ──────────────────────────────────
const OWNER_DOC = [
  'version: 1',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      secret: abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-old-key',
  '',
].join('\n');

test('🔴 主人那份：**只换 refs 那一行**，`records` 逐字节不变', () => {
  const next = renderOwnerKey(OWNER_DOC, 'sk-new-key-123');
  assert.match(next, new RegExp(`^\\s+${OWNER_KEY_REF}: sk-new-key-123$`, 'm'));
  assert.equal(next.includes('sk-old-key'), false, '旧值必须被换掉');
  assert.equal(recordsOf(next), recordsOf(OWNER_DOC), '★ `records`（浏览器会话授权）一个字节都不许动');
  // 别的行也不许动
  assert.match(next, /^version: 1$/m);
  assert.equal(next.endsWith('\n'), true);
});

test('主人那份：`refs:` 在但没有那一行 ⇒ 插进去；认不出的格式 ⇒ **宁可不写**', () => {
  const noRef = 'version: 1\nrefs:\n  OTHER_KEY: x\n';
  const added = renderOwnerKey(noRef, 'sk-new');
  assert.match(added, new RegExp(`^\\s+${OWNER_KEY_REF}: sk-new$`, 'm'));
  assert.match(added, /^ {2}OTHER_KEY: x$/m, '别的 ref 要留着');
  // 预发布那种扁平格式 / 空文件 / 坏值 ⇒ 一律 null（要如实报错，不许猜）
  assert.equal(renderOwnerKey('DEEPSEEK_API_KEY: sk-a\n', 'sk-new'), null);
  assert.equal(renderOwnerKey('', 'sk-new'), null);
  assert.equal(renderOwnerKey(OWNER_DOC, '有中文'), null);
  assert.equal(renderOwnerKey(OWNER_DOC, ''), null);
});

test('🔴 主人那份：先备份、写完自核；**核不过就还原**', () => {
  const dir = tmp();
  try {
    const file = nodePath.join(dir, '.credentials.yaml');
    nodeFs.writeFileSync(file, OWNER_DOC, { mode: 0o600 });
    const r = writeOwnerKey({ file, key: 'sk-fresh', now: () => 111 });
    assert.equal(r.ok, true);
    assert.ok(r.backup.endsWith('.bak.111'), `要留备份：${r.backup}`);
    assert.equal(nodeFs.readFileSync(r.backup, 'utf8'), OWNER_DOC, '备份里必须是改之前那份');
    assert.match(nodeFs.readFileSync(file, 'utf8'), /sk-fresh/);
    assert.equal(nodeFs.statSync(file).mode & 0o777, 0o600);

    // 变异：把一个"写下去就坏掉"的 fs 给它 ⇒ 必须**还原**并如实失败
    const real = nodeFs;
    const broken = {
      readFileSync: (f, e) => real.readFileSync(f, e),
      writeFileSync: (f, body, o) => {
        // 备份照写；正式文件写成一个"records 被改坏"的样子
        const text = f.endsWith('.tmp') ? `${String(body).replace('kind: grant', 'kind: broken')}` : body;
        return real.writeFileSync(f, text, o);
      },
      chmodSync: () => {},
      renameSync: (a, b) => real.renameSync(a, b),
    };
    const r2 = writeOwnerKey({ file, key: 'sk-second', fs: broken, now: () => 222 });
    assert.equal(r2.ok, false, '★ 自检不过就不许说成功');
    assert.equal(r2.why, 'records-changed');
    assert.match(nodeFs.readFileSync(file, 'utf8'), /sk-fresh/, '★ 核不过要把原来那份放回去');
    // 备份写不出来 ⇒ 一步都不许往下走
    const noBackup = {
      readFileSync: (f, e) => real.readFileSync(f, e),
      writeFileSync: (f) => { if (f.includes('.bak.')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
      chmodSync: () => {},
      renameSync: () => {},
    };
    const r3 = writeOwnerKey({ file, key: 'sk-third', fs: noBackup, now: () => 333 });
    assert.equal(r3.ok, false);
    assert.match(r3.why, /备份/);
    assert.match(nodeFs.readFileSync(file, 'utf8'), /sk-fresh/, '没有备份就没动过它');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ④ 路由 ─────────────────────────────────────────────────
async function boot({ setCreds = null, credStatusOf = null } = {}) {
  const dataDir = tmp('hupo-creds-srv-');
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  const auth = new Auth({ dataDir, lockAfter: 3, lockMs: 60_000 });
  auth.setPassword('pw-12345');
  const say = new SayService({ timeline, store, timelineId: 'main' });
  const { listen, close } = createServer({
    timeline, store, auth, say, webRoot: null, buildId: 'creds-test',
    tenantStatusOf: () => ({ kind: 'local', state: 'ready' }),
    setCreds, credStatusOf,
  });
  const addr = await listen(0);
  const token = auth.issue({ sub: 'owner' }).token;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    h: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    close: async () => {
      await close();
      nodeFs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('🔴 `/api/creds`：坏字段/空值/非可打印 ⇒ 400；成了 ⇒ 200，**回执里一个字符的值都没有**', async () => {
  let got = null;
  const s = await boot({
    setCreds: (sub, patch) => { got = { sub, patch }; return { ok: true, creds: credStatus(patch) }; },
    credStatusOf: () => ({ model: false, voice: false, image: false, video: false }),
  });
  try {
    const post = (body) => fetch(`${s.origin}/api/creds`, { method: 'POST', headers: s.h, body: JSON.stringify(body) });

    assert.equal((await post({ creds: { nope: 'x' } })).status, 400, '认不出的字段要 400');
    assert.equal((await post({ creds: { image: '   ' } })).status, 400, '空值要 400');
    assert.equal((await post({ creds: { image: 'a\n坏' } })).status, 400, '非可打印字符要 400');
    assert.equal((await post({ creds: [] })).status, 400, '形状不对要 400');
    assert.equal((await post({})).status, 400);

    const SECRET = 'sk-top-secret-value-xyz';
    const ok = await post({ creds: { model: SECRET, voiceAppId: '1300000001' } });
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.equal(text.includes(SECRET), false, '★ 回执里回显了钥匙（这是密钥那条路）');
    assert.equal(text.includes('1300000001'), false, '★ 别的字段的值也不许回显');
    assert.deepEqual(got, { sub: 'owner', patch: { model: SECRET, voiceAppId: '1300000001' } },
      '身份只从令牌来；值要原样交给 setCreds（首尾空格去掉）');

    // 没开这条路 ⇒ 404（不许假装收下了）
    const s2 = await boot();
    try {
      const r = await fetch(`${s2.origin}/api/creds`, { method: 'POST', headers: s2.h, body: JSON.stringify({ creds: { image: 'x' } }) });
      assert.equal(r.status, 404);
    } finally {
      await s2.close();
    }
  } finally {
    await s.close();
  }
});

test('★ `/api/space` 要带上那四样"有没有"（而且**只有有没有**）', async () => {
  const s = await boot({
    credStatusOf: () => ({ model: true, voice: false, image: true, video: false }),
  });
  try {
    const r = await fetch(`${s.origin}/api/space`, { headers: s.h });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.creds, { model: true, voice: false, image: true, video: false });
    assert.equal(body.kind, 'local', '老字段一个都不许少');
  } finally {
    await s.close();
  }
});
