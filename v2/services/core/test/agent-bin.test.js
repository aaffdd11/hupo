// **`dsh` 在哪**（契约 `docs/dev/140-AGENT-BIN.md`）—— 2026-09-29 真机事故的判据。
//
// ── 为什么这一份进硬闸 ────────────────────────────────────────
// 这个缺陷**一个界面信号都没有**：agent 起不来的时候，用户看到的是一句人话
// （*「我现在接不上活。你这句话我记下了，等我缓过来再说。」*），盘上像没发生过。
// 而根因只在 `spawn` 那一行：**裸名 `dsh` + 服务那份很短的 PATH ⇒ ENOENT**。
//
// 2026-09-29 现场（主人 17:57 那句"帮我创建一个上海小学生专用的奥数练习APP…"）：
//   · `serve.log` 里留着一行 `[dispatcher] agent 退了：起不来：可能是
//     【找不到 dsh 程序】(dsh) 或【工作目录不存在】(/home/deploy/hupo-workspace)`
//     —— 而那个工作目录**是在的** ⇒ 就是前半句；
//   · 服务进程自己的 `PATH`（`/proc/<pid>/environ`）里**没有 nvm 那个 bin**，
//     而 `dsh` 只住在那里。
//
// ⇒ 闸钉两件事，缺一条这个缺陷就会回来：
//   ① 默认取值**不靠 PATH**（先找 `node` 同目录那个 `dsh`）；
//   ② 找不到时**开机就拦**（`preflight` 的 problem），不是每轮悄悄失败。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { dshBinProblem, loadConfig, preflight, resolveDshBin } from '../src/config.js';
import { agentEnv, childEnv, withNodeDirOnPath } from '../src/agent-runtime.js';

/** 默认配置（工作目录 = `v2/services/core`，和线上起服务时一样）。 */
const cfgHere = () => loadConfig({}, process.cwd());

test('显式给的（HUPO_DSH_BIN）最优先 —— 容器里就是靠它', () => {
  assert.equal(
    resolveDshBin({ explicit: '/opt/x/dsh', execPath: '/n/bin/node', exists: () => false }),
    '/opt/x/dsh',
  );
});

test('🔴 默认值**不靠 PATH**：先找 `node` 同目录那个 `dsh`（事故的根因就在这儿）', () => {
  const beside = nodePath.join('/prefix/bin', 'dsh');
  assert.equal(
    resolveDshBin({ execPath: '/prefix/bin/node', exists: (p) => p === beside }),
    beside,
    '`node` 旁边那个 dsh 必须被选中 —— 不然 systemd 那份短 PATH 一定让它 ENOENT',
  );
  // 找不到它才退回裸名（那时 PATH 里得有 —— 盒里就是那样）
  assert.equal(resolveDshBin({ execPath: '/prefix/bin/node', exists: () => false }), 'dsh');
});

test('这台机器上：默认解析出来的 `dshBin` 是一个真文件', () => {
  const bin = resolveDshBin({ explicit: null });
  assert.ok(
    nodeFs.existsSync(bin),
    `默认 dshBin 不是一个真文件：${bin} —— agent 会以"起不来"告终（用户看到"接不上活"）`,
  );
});

test('🔴 找不到 `dsh` ⇒ 那句话要**说清怎么办**（用户看到的是"接不上活"）', () => {
  // ① 带路径的：就说这个文件不在
  const p1 = dshBinProblem({ dshBin: '/nope/dsh' }, { exists: () => false });
  assert.ok(p1 && /找不到 dsh/.test(p1), `带路径那条要拦住：${p1}`);
  assert.ok(/接不上活/.test(p1), '要把它**在用户那儿长什么样**写进那句话里（不然没人认得出）');

  // ② 裸名：PATH 里没有 ⇒ 要点名"systemd 那份 PATH 很短"（这是最常撞上的那一档）
  const p2 = dshBinProblem(
    { dshBin: 'dsh' },
    { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, exists: () => false },
  );
  assert.ok(p2 && /PATH 里找不到 dsh/.test(p2), `裸名那条要拦住：${p2}`);
  assert.ok(/systemd/.test(p2), '要点名 systemd 那份短 PATH —— 这就是现场那个坑');
  assert.ok(/HUPO_DSH_BIN/.test(p2), '要给一条能照做的修法');

  // ③ **反向对照**：找得到就必须是 `null`（判据不许永远红）
  assert.equal(
    dshBinProblem({ dshBin: 'dsh' }, { env: { PATH: '/usr/local/bin' }, exists: () => true }),
    null,
  );
  assert.equal(
    dshBinProblem({ dshBin: '/prefix/bin/dsh' }, { exists: () => true }),
    null,
  );
});

test('preflight：`dsh` 找不到 = **拦启动**（不是每轮悄悄失败）', () => {
  const bad = preflight({ ...cfgHere(), dshBin: '/nope/dsh' });
  assert.ok(
    bad.problems.some((p) => /找不到 dsh/.test(p)),
    `开机没拦住：${JSON.stringify(bad.problems)}`,
  );
  // 正向对照：默认那份配置（这台机器上 `dsh` 就在 `node` 旁边）**不该**因为它红
  const good = preflight(cfgHere());
  assert.ok(
    !good.problems.some((p) => /dsh/i.test(p)),
    `默认配置不该报 dsh：${JSON.stringify(good.problems)}`,
  );
});

test('🔴 第二层：孩子的 `PATH` 里必须看得见我们那个 `node`（`dsh` 的 shebang 是 `env node`）', () => {
  // 事故现场的第二层：`dsh` 用绝对路径找到了，可它是 `#!/usr/bin/env node`
  // ⇒ 那份短 PATH 里没有 `node` ⇒ 退出码 127，用户看到的还是"接不上活"。
  const nodeDir = nodePath.dirname(process.execPath);
  const env = childEnv({ home: '/tmp/x', extra: {} });
  assert.ok(
    String(env.PATH).split(nodePath.delimiter).includes(nodeDir),
    `孩子的 PATH 里没有 node 那一格（${nodeDir}）：${env.PATH}`,
  );
  // 顺序：**我们这一格在最前面**（外面那份 PATH 可能指着一份别的 node）
  assert.equal(String(env.PATH).split(nodePath.delimiter)[0], nodeDir, 'node 那一格要在最前面');

  // 纯函数那一半：空 PATH / 重复项 / 带 dsh 那一格
  assert.equal(withNodeDirOnPath('', ['/opt/dshbin']), `/opt/dshbin${nodePath.delimiter}${nodeDir}`);
  assert.equal(
    withNodeDirOnPath(`/usr/bin${nodePath.delimiter}${nodeDir}`, [nodeDir]),
    `${nodeDir}${nodePath.delimiter}/usr/bin`,
    '重复的要去掉，而且不许把外面那份 PATH 弄丢',
  );
});

test('`agentEnv`：`dshBin` 那一格也在孩子的 `PATH` 里（它是 node CLI，自己还会起东西）', () => {
  const cfg = { ...cfgHere(), dshBin: '/opt/prefix/bin/dsh', dshHome: '/tmp/x' };
  const env = agentEnv(cfg);
  const parts = String(env.PATH).split(nodePath.delimiter);
  assert.ok(parts.includes('/opt/prefix/bin'), `dshBin 那一格不在 PATH 里：${env.PATH}`);
  assert.ok(parts.includes(nodePath.dirname(process.execPath)), 'node 那一格不许丢');
  // ⚠️ 秘密仍然要被摘掉（这条不是新规矩，只是别让这次改动破坏它）
  assert.equal(env.HUPO_MODEL_KEY, undefined);
});
