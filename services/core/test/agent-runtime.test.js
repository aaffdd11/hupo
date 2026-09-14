// agent 运行时的并发与生命周期测试。
//
// 守两条踩过的坑：
//   1. **并发 start() 只能起一个进程** —— 预热和用户第一句话几乎同时到达，
//      不挡就会 spawn 两次，两个进程的 stdout 灌进同一个缓冲区、协议全乱。
//      症状是偶发的「这条我没能给出结论」，很难复现，所以必须有测试钉住。
//   2. **spawn 失败不能带崩服务** —— systemd 窄 PATH 找不到 dsh 时，
//      没接 child.on('error') 会让整个进程退出、systemd 反复重启。
//
// 跑：node --test "test/*.test.js"

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRuntime } from '../src/agent-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 造一个假的 dsh：记下"我被启动了几次"，并按协议回 initialize。 */
function makeStub(dir) {
  const counter = path.join(dir, 'spawns.txt');
  const stub = path.join(dir, 'fake-dsh.mjs');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(counter)}, 'spawn\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      // 故意慢一点：把"预热"和"第一句话"压进同一个窗口
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { serverInfo: { name: 'fake', version: '0' } },
        }) + '\\n');
      }, 60);
    } else if (msg.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { messageId: 'u1' } }) + '\\n');
    } else if (msg.method === 'shutdown') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
      process.exit(0);
    }
  }
});
`,
    { mode: 0o755 },
  );
  return { stub, counter };
}

function baseCfg(stub, extra = {}) {
  return {
    dshBin: stub,
    agentProfile: 'sdk',
    personaPath: '',
    agentCwd: os.tmpdir(),
    agentProvider: 'p',
    agentModel: 'm',
    agentEffort: 'low',
    agentMaxTokens: 100,
    agentBootTimeoutMs: 5000,
    agentIdleEvictMs: 0,
    ...extra,
  };
}

const countSpawns = (counter) => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('并发 start() 只起一个 agent 进程（竞态回归）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-race-'));
  const { stub, counter } = makeStub(dir);
  const runtime = new AgentRuntime(baseCfg(stub));

  const a = runtime.agent('c1');
  // 预热 + 第一句话 + 再来一次：三个并发，只能起一个进程
  await Promise.all([a.start(), a.start(), a.start()]);

  assert.equal(countSpawns(counter), 1, '并发 start() 起了不止一个进程');
  await runtime.shutdown();
});

test('不同会话各自一个进程，预热不会互相顶掉', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-multi-'));
  const { stub, counter } = makeStub(dir);
  const runtime = new AgentRuntime(baseCfg(stub));

  await Promise.all([runtime.agent('c1').start(), runtime.agent('c2').start()]);
  assert.equal(countSpawns(counter), 2);

  // 重复 start 不该再起新的
  await runtime.agent('c1').start();
  assert.equal(countSpawns(counter), 2);

  const stats = runtime.stats();
  assert.equal(stats.sessions, 2);
  assert.equal(stats.ready, 2);
  await runtime.shutdown();
});

test('每个进程生命周期用不同的 DSH 会话 id（SDK 不能 resume）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sid-'));
  const { stub } = makeStub(dir);
  const cfg = baseCfg(stub);

  const r1 = new AgentRuntime(cfg);
  const r2 = new AgentRuntime(cfg);
  // 同一个业务会话，两次启动必须是两个 DSH 会话 id ——
  // 否则磁盘上已有同名日志，session/prompt 会报 `already exists`
  assert.notEqual(r1.dshSessionId('c_main'), r2.dshSessionId('c_main'));
  assert.match(r1.dshSessionId('c_main'), /^c_main\./);
});

test('可执行文件不存在时：start() 失败，但**不会**把进程带崩', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-enoent-'));
  const runtime = new AgentRuntime(baseCfg(path.join(dir, 'does-not-exist')));
  const a = runtime.agent('c1');

  let fired = false;
  a.on('exit', () => {
    fired = true;
  });

  await assert.rejects(() => a.start());
  assert.equal(fired, true, 'spawn 失败必须走 exit 事件（否则调用方永远挂着）');
  await runtime.shutdown();
});
