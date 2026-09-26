// **语音凭据那条路**的判据（P1-26）。
//
// 守的几条：
//   ① 🔴 **换一把钥匙 ⇒ 不用重启**（`data/asr.env` 每次现读；B5 轮换那件事要用它）
//   ② 🔴 **密钥一个字符都不进日志**（`describeVoiceCreds` 只报长度与来源）
//   ③ **没配 ⇒ 如实说"没配"**（不许假装开麦；而且要说得出为什么）
//   ④ **中继按连接取凭据**（`config` 可以是函数）⇒ 不同连接可以拿到不同的一份
//   ⑤ **身份只从 `claim` 来**（`sub` 是选凭据的键，不是这条连接自己报的东西）
//   ⑥ 🔴 **P2-2（2026-09-25）：兜底那份只给主人** —— 别人没填自己的 ⇒ 如实"没配"，
//      主人（`owner`/`local`）照旧吃 `data/asr.env` 那份兜底（**他的钥匙不动**）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { createAsrRelay } from '../src/asr.js';
import { writeUserCreds } from '../src/creds-store.js';
import {
  defaultAsrEnvFile,
  describeVoiceCreds,
  parseEnvFile,
  resolveVoiceCreds,
  voiceCredsFor,
} from '../src/asr-creds.js';

function tmp() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-asr-creds-'));
}

// ⚠️ 这几串**两次踩坑之后**才长成这样，两个理由都要留着：
//    ① **不许是标签的子串**：第一版用了 `SECRETKEY…`，而那句话里写着 `SECRET_KEY`
//       ⇒ 判据自己假红；
//    ② 🔴 **不许长得像真的**：第二版用了 `AKID…`（腾讯 SecretId 的形状）
//       ⇒ **GitHub 的推送保护当场拦下**（"Push cannot contain secrets"）——
//       仓库规则拦的是**形状**，它不看你是不是测试数据。
//    ⇒ 假钥匙就写成一望而知的假（`fake-…`），这样既不会被误判，也不会被当成泄露。
const KEYS = {
  TENCENT_APPID: '1300000001',
  TENCENT_SECRET_ID: 'fake-secret-id-for-test-only',
  TENCENT_SECRET_KEY: 'fake-secret-key-for-test-only-abcd',
};

/** 照 `restart-core.sh` 那种写法落一份（主人是手写的 ⇒ 注释/空行/引号都要认）。 */
function writeEnvFile(dir, body) {
  const f = defaultAsrEnvFile(dir);
  nodeFs.writeFileSync(f, body, { mode: 0o600 });
  return f;
}

// ── ① 读文件与轮换 ──────────────────────────────────────────
test('`KEY=VALUE` 那种文件：注释/空行/引号都认，坏行跳过（**不抛**）', () => {
  const o = parseEnvFile([
    '# 这是注释',
    '',
    'TENCENT_APPID=1300000001',
    'TENCENT_SECRET_ID="AKIDxxxx"',
    "TENCENT_SECRET_KEY='SKxxxx'",
    '没有等号的一行',
    '=只有值没有名字',
    '2数字开头=不许（不是合法变量名）',
    '别的变量=名字不是 ASCII ⇒ 跳过（不是错）',
  ].join('\n'));
  assert.equal(o.TENCENT_APPID, '1300000001');
  assert.equal(o.TENCENT_SECRET_ID, 'AKIDxxxx', '两边的引号要脱掉');
  assert.equal(o.TENCENT_SECRET_KEY, 'SKxxxx');
  assert.equal(o['别的变量'], undefined, '名字不是 ASCII ⇒ 跳过（这种行多半是粘错了）');
  assert.equal(o['没有等号的一行'], undefined);
  assert.equal(o['2数字开头'], undefined);
});

test('🔴 轮换：**同一个进程里**再取一次 ⇒ 读到的是新钥匙（不用重启）', () => {
  const dir = tmp();
  try {
    writeEnvFile(dir, 'TENCENT_APPID=1\nTENCENT_SECRET_ID=a\nTENCENT_SECRET_KEY=b\n');
    const before = resolveVoiceCreds({ dataDir: dir, env: {} });
    assert.equal(before.configured, true);
    assert.equal(before.source, 'file');
    assert.equal(before.appid, '1');

    // 主人轮换：把那三行换掉（B5 就是这么做的）
    writeEnvFile(dir, 'TENCENT_APPID=2\nTENCENT_SECRET_ID=aa\nTENCENT_SECRET_KEY=bb\n');
    const after = resolveVoiceCreds({ dataDir: dir, env: {} });
    assert.equal(after.appid, '2', '★ 换完**不用重启**就该读到新的（现读的那份文件）');
    assert.equal(after.secretKey, 'bb');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('③ 没配 ⇒ 如实说"没配"，而且说得出为什么（文件不在 vs 文件在但缺项）', () => {
  const dir = tmp();
  try {
    const empty = resolveVoiceCreds({ dataDir: dir, env: {} });
    assert.equal(empty.configured, false);
    assert.equal(empty.source, 'none');
    assert.match(empty.why, /还没有那份钥匙文件/);

    writeEnvFile(dir, 'TENCENT_APPID=1\n'); // 只写了一半
    const half = resolveVoiceCreds({ dataDir: dir, env: {} });
    assert.equal(half.configured, false);
    assert.match(half.why, /没有那三样|只写了一半/);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('③ 读不出来（比如权限不对）⇒ 当成没配，但**说得出是哪一种**', () => {
  const dir = tmp();
  try {
    const f = writeEnvFile(dir, 'TENCENT_APPID=1\nTENCENT_SECRET_ID=a\nTENCENT_SECRET_KEY=b\n');
    nodeFs.chmodSync(f, 0o000);
    const fake = {
      existsSync: (p) => nodeFs.existsSync(p),
      readFileSync: () => {
        const e = new Error('EACCES');
        e.code = 'EACCES';
        throw e;
      },
    };
    const cfg = resolveVoiceCreds({ dataDir: dir, env: {}, fs: fake });
    assert.equal(cfg.configured, false);
    assert.match(cfg.why, /读不出来/, `要说清是"读不出来"：${cfg.why}`);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('② 🔴 日志那一句**一个字符的钥匙都不带**（只有长度与来源）', () => {
  const dir = tmp();
  try {
    writeEnvFile(dir, Object.entries(KEYS).map(([k, v]) => `${k}=${v}`).join('\n'));
    const cfg = resolveVoiceCreds({ dataDir: dir, env: {} });
    const said = describeVoiceCreds(cfg);
    // 负向对照：上面那几串**真的读进去了**（不然"没泄漏"是因为压根没读到）
    assert.equal(cfg.appid, KEYS.TENCENT_APPID);
    assert.equal(cfg.secretKey, KEYS.TENCENT_SECRET_KEY);
    for (const v of Object.values(KEYS)) {
      assert.equal(said.includes(v), false, `★ 日志里不许出现钥匙：${said}`);
      assert.equal(said.includes(v.slice(0, 6)), false, `★ 连前几位都不许：${said}`);
      assert.equal(said.includes(v.slice(-4)), false, `★ 末四位也不许：${said}`);
    }
    assert.match(said, /来源 file/);
    assert.match(said, /APPID \d+ 位/);
    // 没配时那句话也一样安全
    assert.match(describeVoiceCreds(resolveVoiceCreds({ dataDir: tmp(), env: {} })), /没配语音凭据/);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 🔴 P2-2：兜底那份**只给主人**；别人没填自己的 ⇒ 如实"没配"', () => {
  const dir = tmp();
  try {
    writeEnvFile(dir, Object.entries(KEYS).map(([k, v]) => `${k}=${v}`).join('\n'));
    // ── 别人（租户）：不吃兜底 —— 认不出/不是主人 ⇒ `none`
    for (const who of ['u1', 'u2', null, 'local-user']) {
      const other = voiceCredsFor({ sub: who, dataDir: dir, env: {} });
      assert.equal(other.source, 'none', `★ ${String(who)} 不许吃部署默认那份（那是主人的钥匙）`);
      assert.equal(other.configured, false, '★ 没填自己的 ⇒ 如实说"没配"');
      assert.equal(other.appid, '', '★ 一个字符的钥匙都不许递出去');
      assert.equal(other.secretKey, '');
      assert.match(other.why, /没填|没配|只给主人/, `要说得出为什么：${other.why}`);
    }
    // ── 🔴 反例（主人那一份**一个字都不动**）：`owner` / `local` 照旧吃兜底
    for (const owner of ['owner', 'local']) {
      const mine = voiceCredsFor({ sub: owner, dataDir: dir, env: {} });
      assert.equal(mine.source, 'default', `★ ${owner} 是主人 ⇒ 兜底照旧能用`);
      assert.equal(mine.configured, true);
      assert.equal(mine.appid, KEYS.TENCENT_APPID);
      assert.equal(mine.secretKey, KEYS.TENCENT_SECRET_KEY);
      assert.equal(mine.sub, owner);
    }
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});


// ── ④ 中继按连接取凭据 ──────────────────────────────────────
test('🔴 中继：`config` 是函数 ⇒ **每条连接各取一份**（一条"没配"不影响另一条）', () => {
  const relay = createAsrRelay({
    config: (info) => (info.sub === 'mei-qian'
      ? { configured: false }
      : { configured: true, appid: '1', secretId: 'a', secretKey: 'b', engine: '16k_zh', upstream: null }),
    log: () => {},
  });
  // 构造两条假连接，只看它们各自收到什么
  const make = () => {
    const got = [];
    return {
      got,
      OPEN: 1,
      readyState: 1,
      send: (s) => got.push(JSON.parse(s)),
      close: () => {},
      on: () => {},
    };
  };
  const poor = make();
  relay.attach(poor, { sub: 'mei-qian' });
  assert.deepEqual(poor.got[0], { type: 'asr/unavailable', reason: 'not-configured' },
    '★ 没配的那位要收到如实那一句（而不是握手失败）');

  const rich = make();
  relay.attach(rich, { sub: 'you-qian' });
  assert.notEqual(rich.got[0]?.type, 'asr/unavailable',
    `★ 有配的那位不该被判成"没配"：${JSON.stringify(rich.got)}`);

  // ⚠️ 函数式 config ⇒ 开机那一刻**不知道**有没有配 ⇒ 如实回 null（不许回 undefined）
  assert.equal(relay.configured, null);
  // 负向对照：老形状（一份 config）仍然照旧
  const fixed = createAsrRelay({ config: { configured: true, engine: '16k_zh' }, log: () => {} });
  assert.equal(fixed.configured, true);
  assert.equal(createAsrRelay({ config: { configured: false }, log: () => {} }).configured, false);
});

// ── ★ P1-26 后半：**他自己填的那三样优先**（2026-09-24）──────────
test('★ 🔴 配置页那三样填了 ⇒ **就用他的**（来源如实写 `his-own`）', () => {
  const dir = tmp();
  try {
    // 部署默认那一份也在（负向对照要靠它：证明不是"默认那份没了才用他的"）
    writeEnvFile(dir, 'TENCENT_APPID=999\nTENCENT_SECRET_ID=env-id\nTENCENT_SECRET_KEY=env-key\n');
    const w = writeUserCreds(dir, 'u1', {
      voiceAppId: '1300000001',
      voiceSecretId: 'mine-id',
      voiceSecretKey: 'mine-key',
    });
    assert.equal(w.ok, true);
    assert.equal(w.status.voice, true, '三样齐了 ⇒ 页面那边也该说"有"');

    const cfg = voiceCredsFor({ sub: 'u1', dataDir: dir, env: {} });
    assert.equal(cfg.source, 'his-own');
    assert.equal(cfg.appid, '1300000001');
    assert.equal(cfg.secretId, 'mine-id');
    assert.equal(cfg.secretKey, 'mine-key');
    assert.equal(cfg.configured, true);
    assert.equal(cfg.sub, 'u1', '要记住这是谁的（日志用）');

    // 负向对照：**别人**那一份不许用在他身上（P2-2：别人连兜底都没有）
    const other = voiceCredsFor({ sub: 'u2', dataDir: dir, env: {} });
    assert.equal(other.source, 'none', '★ 乙没填 ⇒ 不许用部署默认那一份（那是主人的钥匙）');
    assert.equal(other.configured, false);
    assert.equal(other.appid, '');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 三样**缺一** ⇒ 不算"他填了"（别人 ⇒ 没配；主人 ⇒ 退回兜底）', () => {
  const dir = tmp();
  try {
    writeEnvFile(dir, 'TENCENT_APPID=999\nTENCENT_SECRET_ID=env-id\nTENCENT_SECRET_KEY=env-key\n');
    writeUserCreds(dir, 'u1', { voiceAppId: '1300000001', voiceSecretId: 'mine-id' }); // 少 secretKey
    const cfg = voiceCredsFor({ sub: 'u1', dataDir: dir, env: {} });
    assert.equal(cfg.source, 'none', '★ 只有两样 ⇒ 当没填过（缺一样发不出请求）');
    assert.equal(cfg.configured, false, '★ P2-2：别人缺一样 ⇒ 如实"没配"，不许拿兜底顶上');
    assert.equal(cfg.secretKey, '');
    // 负向对照：主人缺一样 ⇒ 兜底照旧（**他的钥匙没被动**）
    const owner = voiceCredsFor({ sub: 'owner', dataDir: dir, env: {} });
    assert.equal(owner.source, 'default', '★ 主人缺一样 ⇒ 仍然吃兜底');
    assert.equal(owner.configured, true);
    assert.equal(owner.appid, '999');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('他自己填了 ⇒ 不许走"取证中转"（那是给没钥匙时验链路用的）', () => {
  const dir = tmp();
  try {
    writeEnvFile(dir, 'HUPO_ASR_URL=ws://127.0.0.1:1/up\nTENCENT_APPID=999\nTENCENT_SECRET_ID=e\nTENCENT_SECRET_KEY=k\n');
    writeUserCreds(dir, 'u1', { voiceAppId: '1', voiceSecretId: 'a', voiceSecretKey: 'b' });
    const cfg = voiceCredsFor({ sub: 'u1', dataDir: dir, env: {} });
    assert.equal(cfg.source, 'his-own');
    assert.equal(cfg.upstream, null, '★ 用他自己的钥匙时不许再指向中转');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── ★ `#174`（2026-09-27）：**盒子那台读的是"单文件"那一份** ─────────────
//
// 🔴 修之前这里是**坏的**：`voiceCredsFor` 调 `credsFor` 时**没把 `env` 传下去**，
//    而 `credsFor` 的"盒子里读单文件"那一支**只在 `HUPO_ROLE=tenant` 时**才走
//    （它的 `env` 默认是空对象）⇒ 钥匙推进盒子了、`/data/creds.yaml` 里明明有，
//    识别路照样回「没配凭据」。
// ⚠️ 这条判据打的就是**产品这条路**（`voiceCredsFor`），不是 `credsFor` 本身 ——
//    "判据打在另一侧"那一族就是这么来的。
test('★ 🔴 盒子里那份**单文件**：识别路要读得到（`env` 必须传下去）', async () => {
  const dir = tmp();
  try {
    const { mergeKeyFile, writeKeyFile } = await import('../src/tenant-shell.mjs');
    const file = nodePath.join(dir, 'creds.yaml');
    writeKeyFile(file, 'sk-box-model'); // 老的：只有模型那一把
    mergeKeyFile(file, {
      voiceAppId: '1300000001',
      voiceSecretId: 'box-id',
      voiceSecretKey: 'box-key',
    });
    // 盒子里：那份单文件 ＋ `HUPO_ROLE=tenant` ⇒ 必须认出来
    const cfg = voiceCredsFor({ sub: 'owner', dataDir: dir, env: { HUPO_ROLE: 'tenant' } });
    assert.equal(cfg.configured, true, '★ 盒子里推进去的三样要真的接上识别路');
    assert.equal(cfg.source, 'his-own');
    assert.equal(cfg.appid, '1300000001');
    assert.equal(cfg.secretKey, 'box-key');

    // 负向对照：**没有那一台的角色** ⇒ 宿主上不许拿一份陈旧单文件去顶（宁可说"没配"）
    const host = voiceCredsFor({ sub: 'owner', dataDir: dir, env: {} });
    assert.equal(host.configured, false, '★ 宿主上不认那份单文件（免得"看不出原因"）');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});
