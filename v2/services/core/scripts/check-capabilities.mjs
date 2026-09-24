#!/usr/bin/env node
// 能力层那条**真链路**：起一次**真的 dsh**，证明它真的把我们的补丁挂上了。
//
// 判据分两段，各自证明一件不同的事（**两件都不能省**）：
//
//   ① `--dump-config`：**仓库那一份** `hupo-capabilities.yml` 能组合进配置树，
//      而且 `!!js process.env.…` 真的把三个变量代进去了。
//      —— 这一段证明"文件写对了"。
//   ② **真启动**：hds 起来之后**真的去 spawn 了那台 MCP 服务器**、并问了它的工具列表。
//      —— 这一段证明"挂上去了"。`--dump-config` 证明不了这个。
//
// ②里那台"服务器"是一个**录音桩**（把收到的每个方法记到文件里）：
// 这样"它到底有没有被拉起来、有没有被问 tools/list"是**看得见的事实**，
// 不是我们的推断。（⚠️ 不能用我们那支真服务器来当证据 —— 它自己说自己被拉起来了，
// 那叫自证。）
//
// 用法：
//   node scripts/check-capabilities.mjs
//
// 退出码：0 = 两段都过；非 0 = 哪一段没过就报哪一段。

import nodeChildProcess from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

// ⚠️ 这个脚本住在 `v2/services/core/scripts/`：从它自己推**两级**才是 core，
//    再往上两级才是仓库根。（第一次写错成 `..`，于是 patch 路径多套了一层
//    `v2/services/core/` —— dsh 报的是"读不到那个文件"，看着像它的问题。）
const CORE = nodePath.resolve(nodePath.dirname(new URL(import.meta.url).pathname), '..');
const REPO = nodePath.resolve(CORE, '..', '..');
const PATCH = nodePath.join(CORE, 'hupo-capabilities.yml');
const SERVER = nodePath.join(CORE, 'src', 'mcp-ledger-server.mjs');

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };

const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-cap-check-'));
const logFile = nodePath.join(tmp, 'recorder.jsonl');
const recorder = nodePath.join(tmp, 'recorder.mjs');
const dshHome = nodePath.join(tmp, 'dsh');

// ── 录音桩：一个最小的 stdio MCP 服务器 ──────────────────────
nodeFs.writeFileSync(recorder, `
import nodeFs from 'node:fs';
import nodeReadline from 'node:readline';
const log = process.env.HUPO_PROBE_LOG;
const tools = [{ name: 'probe_ping', description: '探针', inputSchema: { type: 'object', properties: {} } }];
const rl = nodeReadline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  nodeFs.appendFileSync(log, JSON.stringify({ method: msg.method, name: msg.params?.name ?? null }) + '\\n');
  if (msg.id === undefined) return;
  const out = msg.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
    : msg.method === 'tools/list' ? { tools }
    : msg.method === 'tools/call' ? { content: [{ type: 'text', text: 'pong' }] }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: out }) + '\\n');
});
`);

// DSH_HOME 用**临时副本**：这一段不许动真 profile（那里是开机清单的 strict 条目）。
nodeFs.mkdirSync(dshHome, { recursive: true });
nodeChildProcess.execFileSync('cp', ['-a', nodePath.join(nodeOs.homedir(), '.dsh', 'profiles'), dshHome]);

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  PATH: `${nodePath.join(nodeOs.homedir(), '.nvm', 'versions', 'node', 'v24.15.0', 'bin')}:${process.env.PATH}`,
  HUPO_NODE_BIN: process.execPath,
  HUPO_LEDGER_SERVER: recorder, // ★ 换成录音桩：它被拉起来这件事要**看得见**
  HUPO_LEDGER_SOCKET: nodePath.join(tmp, 'ledger.sock'),
  // ★ 小程序那两条（乙-2 · `59-USER-APPS.md`）：**也要一起给** ——
  //   少一个变量，`!!js` 求值出来就是 `undefined`，dsh 会判 `invalid config`
  //   然后整棵树加载失败（慢闸当场抓到过）。
  HUPO_APPS_SERVER: recorder,
  HUPO_APPS_SOCKET: nodePath.join(tmp, 'apps.sock'),
  // ★ **画图那一支**（P1-27 后半）：它也是被 dsh spawn 起来的一条 ⇒ 也得给桩
  HUPO_IMAGE_SERVER: recorder,
  HUPO_PROBE_LOG: logFile,
};

// ── ① 组合进配置树 ──────────────────────────────────────────
//
// ⚠️ 这一段**只能证明"文件写对了"**：`--dump-config` 的原文就是
//    "booting or **evaluating** `!!js`" **之外**的那一半 ⇒ `!!js` 会
//    **原样打出来、不求值**（实测）。所以这里断言的是"表达式在、而且
//    仓库里没有写死绝对路径"，**代换有没有真的发生由 ② 证明**
//    （桩真的被拉起来 = 那三个变量真的代进去了）。
console.log('① `--dump-config`：仓库那一份补丁能不能组合进树');
try {
  const out = nodeChildProcess.execFileSync(
    'dsh', ['--profile', 'sdk', '--patch', PATCH, '--dump-config'],
    { env, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
  );
  const hasEntry = out.includes('@deepseek-ai/dsh-mcp-client');
  const hasName = /serverName:\s*ledger/.test(out);
  const usesEnv = /!!js\s+process\.env\.HUPO_NODE_BIN/.test(out) && /HUPO_LEDGER_SOCKET/.test(out);
  // ⚠️ 这条要查**仓库里那个文件本身**，不能查 dump：dump 里每条覆盖层都带一行
  //    `# == <这个补丁的路径>`，于是"本机绝对路径"必然出现 —— 那是假红。
  const src = nodeFs.readFileSync(PATCH, 'utf8');
  const hardCoded = /(^|\s)\/(home|Users|opt|srv)\//m.test(src);
  if (hasEntry) ok('能力层那条插件在树里（@deepseek-ai/dsh-mcp-client）'); else bad('树里没有那条插件 —— 补丁没生效');
  if (hasName) ok('serverName 是 ledger ⇒ 模型看到的名字会是 mcp__ledger__*'); else bad('serverName 没代进去');
  if (usesEnv) ok('值是 `!!js process.env.…`（路径不写死在仓库里）'); else bad('没有看到从环境取值 —— 路径会写死');
  if (!hardCoded) ok('树里没有本机的绝对路径（生产机是另一个 checkout，路径不一样）'); else bad('仓库文件里写死了本机路径');
} catch (err) {
  bad(`--dump-config 跑失败：${err?.stderr ?? err?.message ?? err}`);
}

// ── ② 真启动：它到底有没有被拉起来、有没有被问工具 ───────────
console.log('② 真启动 dsh：它会不会真的把 MCP 服务器拉起来');
const args = ['--profile', 'sdk', '--patch', nodePath.join(CORE, 'hupo-persona.yml'), '--patch', PATCH];
const child = nodeChildProcess.spawn('dsh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
const childErr = [];
child.stdout.resume();
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => childErr.push(String(c)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = () => (nodeFs.existsSync(logFile) ? nodeFs.readFileSync(logFile, 'utf8') : '');
const deadline = Date.now() + 60000;
let got = { init: false, list: false };
while (Date.now() < deadline) {
  const text = seen();
  got.init = text.includes('"method":"initialize"');
  got.list = text.includes('"method":"tools/list"');
  if (got.init && got.list) break;
  await sleep(500);
}
child.kill('SIGKILL');

if (got.init) ok('dsh **真的 spawn 了**那台服务器（它收到了 initialize）');
else bad('那台服务器没被拉起来 —— 补丁没挂上，或者它启动就失败了');
if (got.list) ok('dsh 问了它的工具列表（tools/list）⇒ 工具会被桥接给模型');
else bad('没问 tools/list ⇒ 工具不会出现在模型那一侧');
if (seen().length > 0) console.log(`    （录音：${seen().trim().split('\n').length} 条）`);
// ⚠️ 失败了要把 **dsh 自己说的话**打出来：不然只剩"它没起来"这一句，
//    而"为什么没起来"全在那段 stderr 里。
if (process.exitCode && childErr.length > 0) {
  console.error('    dsh 的 stderr（前 15 行）：');
  for (const line of childErr.join('').split('\n').slice(0, 15)) console.error(`      ${line}`);
}

// ── ③ 用**我们那支真服务器**再起一次：证明它不会把 dsh 的启动弄挂 ──
//
// ② 用的是录音桩（那样"被拉起来"才是可观察的事实）。但它证明不了
// **我们这支**脚本自己起得来 —— 而 `failOnStartupError: true` 意味着
// 它起不来就会**把整个 agent 弄挂**（用户那边是"它不答话了"）。
// 所以这一段不能省：真服务器 + 真套接字，看 dsh 是不是**干净地**起来。
console.log('③ 用真服务器再起一次：它会不会把 dsh 弄挂');
{
  const nodeNet = await import('node:net');
  const net = nodeNet.default;
  const { Store } = await import('../src/store.js');
  const { Timeline } = await import('../src/timeline.js');
  const { Ledger } = await import('../src/ledger.js');
  const { LedgerSocket, ledgerSocketPath } = await import('../src/ledger-socket.js');
  // ★ 小程序那一条也要有**真的**通道（乙-2）：不然模型真调它时会连不上
  const { Apps } = await import('../src/apps.js');
  const { AppsSocket, appsSocketPath } = await import('../src/apps-socket.js');

  const dataDir = nodePath.join(tmp, 'realdata');
  nodeFs.mkdirSync(dataDir, { recursive: true });
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'ledger', store });
  const ledger = new Ledger({ store, timeline }).sync();
  const sockPath = ledgerSocketPath(dataDir);
  const sock = new LedgerSocket({ ledger, socketPath: sockPath }).listen();
  await sock.ready();

  const APPS_SERVER = nodePath.join(CORE, 'src', 'mcp-apps-server.mjs');
const IMAGE_SERVER = nodePath.join(CORE, 'src', 'mcp-image-server.mjs');
  const apps = new Apps({ dir: dataDir, sub: 'check' });
  const appsSockPath = appsSocketPath(dataDir);
  const appsSock = new AppsSocket({ apps, socketPath: appsSockPath }).listen();
  await appsSock.ready();

  const realEnv = {
    ...env,
    HUPO_LEDGER_SERVER: SERVER,
    HUPO_LEDGER_SOCKET: sockPath,
    HUPO_APPS_SERVER: APPS_SERVER,
    HUPO_APPS_SOCKET: appsSockPath,
    HUPO_IMAGE_SERVER: IMAGE_SERVER,
  };
  delete realEnv.HUPO_PROBE_LOG;
  const args3 = ['--profile', 'sdk', '--patch', nodePath.join(CORE, 'hupo-persona.yml'), '--patch', PATCH];
  const c3 = nodeChildProcess.spawn('dsh', args3, {
    env: realEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const err3 = [];
  c3.stdout.resume();
  c3.stderr.setEncoding('utf8');
  c3.stderr.on('data', (d) => err3.push(String(d)));
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { c3.kill('SIGKILL'); resolve('timeout'); }, 30000);
    c3.on('exit', (c) => { clearTimeout(t); resolve(c); });
    // 关掉 stdin ⇒ 它把这一轮服务收干净、正常退出
    c3.stdin.end();
  });
  const noisy = err3.join('');
  const pluginFailed = /mcp|plugin|fail/i.test(noisy) && /error|fail|throw/i.test(noisy);
  if (code === 0 && !pluginFailed) ok(`真服务器在场时 dsh 干净退出（code ${code}）`);
  else bad(`真服务器把 dsh 弄挂了（code ${code}）：${noisy.split('\n').slice(0, 6).join(' / ')}`);

  // ★ 顺带证明**那条口真的能写**：经真服务器那条路走一遍（不是自己直连）
  const roundTrip = await new Promise((resolve) => {
    const conn = net.connect(sockPath);
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify({
      op: 'write',
      fields: { kind: '装空调', qty: 3, unit: '台', unitPrice: 1200, tax: false, date: '2026-08-20' },
      said: '上周装了三台空调，一台一千二，不含税',
    })}\n`));
    conn.on('data', (d) => { buf += d; if (buf.includes('\n')) { conn.destroy(); resolve(buf.trim()); } });
    conn.on('error', () => resolve('{}'));
  });
  if (/"ok":true/.test(roundTrip) && ledger.list().length === 1) {
    ok('那条口走通了：写一笔 → 盘上多一条');
  } else {
    bad(`那条口没写进去：${roundTrip}`);
  }
  sock.close();
}

// ── 收尾 ────────────────────────────────────────────────────
try { nodeFs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力 */ }
if (process.exitCode) { console.error('\n❌ 能力层这条链路**没通**'); process.exit(1); }
console.log('\n✅ 通过：仓库那份补丁能组合、dsh 真会把它拉起来并问工具');
