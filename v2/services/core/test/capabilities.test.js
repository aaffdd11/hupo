// 能力层**接进去了没有**（批 4 · 契约 `docs/dev/31-LEDGER.md` v2 §7.1）。
//
// 这一篇是**快闸**：它只查文件与启动参数（毫秒级、每次都跑）。
// "dsh 真会把那台服务器拉起来吗"是**慢闸**，走
// `node scripts/check-capabilities.mjs`（要起真 dsh，几十秒）。
//
// 为什么快慢两道都要（和 AndroidManifest 那两条闸同一个道理）：
//   * 快闸管"平时别改回去"；
//   * 慢闸管"这一版**真的**对"——文件写对了 ≠ dsh 会挂它。
//
// 守的几条：
//   ① 🔴 形状必须是 `- insert: […]`（写成 `- id:` 会被当成改已有条目 ⇒ 静默不生效）
//   ② 🔴 **仓库文件里不许有绝对路径、不许有任何秘密**
//   ③ `config.js` 的默认值指向真实存在的文件；缺了要在 `preflight` 里**当场说**
//   ④ spawn 时**两条 `--patch`**（人格 + 能力），而且能力层挂在后面
//   ⑤ 三个环境变量真的**递进了子进程**（`!!js` 靠它们取值）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { DshAgent } from '../src/agent-runtime.js';
import { loadConfig, preflight } from '../src/config.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const CORE = nodePath.resolve(HERE, '..');
const PATCH = nodePath.join(CORE, 'hupo-capabilities.yml');
const FAKE = nodePath.join(HERE, 'fake-agent.mjs');

const text = () => nodeFs.readFileSync(PATCH, 'utf8');
/** 去掉注释行之后的"会被读进去的那部分"（注释里可以解释为什么禁某样东西）。 */
const payload = () => text().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// ── ①② 文件本身 ─────────────────────────────────────────────

test('🔴 形状是 `- insert: […]`，而且 serverName 是 `ledger`', () => {
  const p = payload();
  assert.match(p, /^-\s*insert:\s*$/m, '必须是 insert 列表（写成 - id: 会被当成改已有条目）');
  assert.match(p, /serverName:\s*ledger/, 'serverName 决定模型看到的名字：mcp__ledger__*');
  assert.match(p, /name:\s*'@deepseek-ai\/dsh-mcp-client'/);
  // ⚠️ 负向：顶层那条 `- id:` 的写法**必须不成立**
  assert.ok(!/^-\s*id:\s*mcp-ledger\s*$/m.test(p), '顶层 - id: 那一条实测会被静默跳过');
});

test('🔴 值从环境来：路径**不写死在仓库里**（生产机是另一个 checkout）', () => {
  const p = payload();
  for (const v of ['HUPO_NODE_BIN', 'HUPO_LEDGER_SERVER', 'HUPO_LEDGER_SOCKET']) {
    assert.ok(p.includes(v), `少了 ${v}：路径写死之后换台机器就起不来`);
  }
  assert.ok(!/(^|\s)\/(home|Users|opt|srv)\//m.test(p), '仓库文件里不许出现本机绝对路径');
});

test('🔴 两条 MCP 都在，而且**每一件都真的能做**（做不了的这一批不挂）', () => {
  const p = payload();
  assert.match(p, /serverName:\s*apps/, '小程序那两条也要挂上：serverName 决定模型看到的名字');
  for (const v of ['HUPO_APPS_SERVER', 'HUPO_APPS_SOCKET']) {
    assert.ok(p.includes(v), `少了 ${v}：路径写死之后换台机器就起不来`);
  }
  // ⚠️ **负向**：这一批还没做的那些动作，**不许**出现在工具说明里 ——
  //    挂了做不了的工具 = 让它去承诺一件做不到的事（本仓库最忌的假话）。
  // ✅ 乙-4b 起**九件全做了**（造/看/发/撤/发现/装/卸/授权/撤权）⇒ 这里不再有"不许挂"的清单。
  //    ⚠️ 留着这一段是因为**将来加新工具时**要在这里先写"它真能做"（见 `59` §八）。
});

test('🔴 这份文件里**没有任何秘密**（准入靠套接字权限，不靠令牌）', () => {
  const p = payload();
  for (const w of ['TOKEN', 'PASSWORD', 'SECRET', 'API_KEY', 'credential']) {
    assert.ok(!p.includes(w), `能力层配置里不许有 ${w} —— 它在仓库里，进了 git 就收不回来`);
  }
});

test('起不来要**当场失败**（不是悄悄少一个工具）', () => {
  assert.match(payload(), /failOnStartupError:\s*true/);
});

// ── ③ 配置与 preflight ──────────────────────────────────────

test('config 的默认值指向真实存在的文件（人格那一份同款待遇）', () => {
  const cfg = loadConfig({}, CORE);
  assert.equal(cfg.capabilitiesPath, PATCH);
  assert.equal(cfg.ledgerServerPath, nodePath.join(CORE, 'src', 'mcp-ledger-server.mjs'));
  assert.ok(nodeFs.existsSync(cfg.capabilitiesPath));
  assert.ok(nodeFs.existsSync(cfg.ledgerServerPath));
  assert.equal(cfg.ledgerSocketPath, nodePath.join(cfg.dataDir, 'ledger.sock'));
  // ★ 小程序那一套（乙-2）：脚本在不在、套接字路径对不对
  assert.equal(cfg.appsServerPath, nodePath.join(CORE, 'src', 'mcp-apps-server.mjs'));
  assert.ok(nodeFs.existsSync(cfg.appsServerPath), '那条 MCP 脚本要在');
  assert.equal(cfg.appsSocketPath, nodePath.join(cfg.dataDir, 'apps.sock'));
  // ★ 制品口"对外那个地址"必须**可配**（乙-5：生产上是另一个域名）
  //   ⚠️ 写死的话，"上线"就得改代码 —— 那正是要避免的形状。
  assert.equal(cfg.appsPublicBase, null, '没配就是本机那个（默认）');
  assert.equal(
    loadConfig({ HUPO_APPS_PUBLIC_BASE: 'https://apps.example' }, CORE).appsPublicBase,
    'https://apps.example',
    '配了就用它',
  );
  assert.deepEqual(preflight(cfg).problems, [], '默认配置下不该有问题');
});

test('🔴 能力层文件不在 ⇒ preflight **说出来**（它坏掉的时候什么都不会报错）', () => {
  const cfg = loadConfig({}, CORE);
  const r = preflight({ ...cfg, capabilitiesPath: '/definitely/not/here.yml' });
  assert.ok(r.problems.some((p) => p.includes('能力层')), r.problems.join('\n'));

  const r2 = preflight({ ...cfg, capabilitiesPath: '' });
  assert.ok(r2.problems.some((p) => p.includes('capabilitiesPath')));

  const r3 = preflight({ ...cfg, ledgerServerPath: '/definitely/not/here.mjs' });
  assert.ok(r3.problems.some((p) => p.includes('MCP 服务器')), r3.problems.join('\n'));
});

// ── ④⑤ 真 spawn 那一层 ──────────────────────────────────────

test('🔴 spawn 时带**两条 --patch**（人格 + 能力），而且三个变量递进了子进程', async () => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-cap-'));
  let seen = null;
  let child = null;
  const spy = (bin, args, opts) => {
    seen = { bin, args, env: opts.env };
    child = realSpawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_SCENARIO: 'normal' } });
    return child;
  };
  const cfg = {
    dshBin: 'unused', agentProfile: 'sdk', agentCwd: dir, dshHome: dir,
    agentProvider: 'fake', agentModel: 'fake', agentEffort: 'low', agentMaxTokens: 512,
    agentBootTimeoutMs: 20000,
    personaPath: nodePath.join(CORE, 'hupo-persona.yml'),
    capabilitiesPath: PATCH,
    ledgerServerPath: nodePath.join(CORE, 'src', 'mcp-ledger-server.mjs'),
    ledgerSocketPath: nodePath.join(dir, 'ledger.sock'),
  };
  const agent = new DshAgent({ sessionId: 's1', cfg, spawnFn: spy });
  try {
    await agent.start();
    const patches = [];
    for (let i = 0; i < seen.args.length; i += 1) {
      if (seen.args[i] === '--patch') patches.push(seen.args[i + 1]);
    }
    assert.deepEqual(patches, [cfg.personaPath, cfg.capabilitiesPath],
      `两条都要在，人格在前、能力在后 —— 实际参数是 ${JSON.stringify(seen.args)}`);
    assert.equal(seen.env.HUPO_NODE_BIN, process.execPath);
    assert.equal(seen.env.HUPO_LEDGER_SERVER, cfg.ledgerServerPath);
    assert.equal(seen.env.HUPO_LEDGER_SOCKET, cfg.ledgerSocketPath);
    // ⚠️ 这三个变量**都不是秘密**；但顺带钉住"递进去的环境里不许夹带令牌"
    for (const k of Object.keys(seen.env)) {
      assert.ok(!/(_TOKEN|_SECRET|_API_KEY)$/i.test(k), `递进去的环境里不许有 ${k}`);
    }
  } finally {
    // ⚠️ **不要 await shutdown()**：假 agent 不答那一条，等它就是等到用例超时
    //    （而超时会连诊断一起吞掉 —— 第一次跑这篇就是这么瞎的）。
    child?.kill('SIGKILL');
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没配能力层（capabilitiesPath 为空）⇒ **不许硬塞一个 --patch**', async () => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-cap-'));
  let seen = null;
  let child = null;
  const spy = (bin, args, opts) => {
    seen = { args, env: opts.env };
    child = realSpawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_SCENARIO: 'normal' } });
    return child;
  };
  const cfg = {
    dshBin: 'unused', agentProfile: 'sdk', agentCwd: dir, dshHome: dir,
    agentProvider: 'fake', agentModel: 'fake', agentEffort: 'low', agentMaxTokens: 512,
    agentBootTimeoutMs: 20000,
    personaPath: null,
    capabilitiesPath: null,
    ledgerServerPath: null,
    ledgerSocketPath: null,
  };
  const agent = new DshAgent({ sessionId: 's2', cfg, spawnFn: spy });
  try {
    await agent.start();
    assert.deepEqual(seen.args, ['--profile', 'sdk'], `不该有 --patch：${JSON.stringify(seen.args)}`);
    assert.ok(!('HUPO_LEDGER_SERVER' in seen.env), 'undefined 不许被塞成字符串 "undefined"');
    assert.ok(!('HUPO_LEDGER_SOCKET' in seen.env));
  } finally {
    child?.kill('SIGKILL');
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});
