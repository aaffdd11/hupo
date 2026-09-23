// **哪些路由必须在他自己那台盒子里答**（多租户的数据面 · `TENANT_ROUTES`）。
//
// ── 为什么要有这一份（2026-09-23 · 批 C 之后补的）──────────────
// 批 C 新加了只读路由 `GET /api/timeline`（「老消息往上翻着加载」靠它）。当时：
//   · 路由写了 ✅ · 纯函数（`planBackfill`）的判据有了 ✅ · 客户端的判据有了 ✅
//   · **忘了把它加进 `TENANT_ROUTES`** ❌
// ⇒ 对**每一个有容器的用户**，这个请求由**宿主**代答：读的是宿主侧那份空的 per-user 盘
//    ⇒ 回 `{frames: [], hasMore: false}` ⇒ 客户端如实说「没有更早的了」——
//    **而他那台盒子的时间线里明明有 65 条**（实测：`GET /api/health` 走同一条隧道报 `seq: 65`）。
// ⇒ 这是「**页面在说假话**」那一类，也正是判据 **V13** 的形状：
//    **宿主会不会代答，只有打在这一侧才看得见**（纯函数判据、客户端判据全绿也照样漏）。
//
// ── 这一份怎么判（**打的是可观察行为，不是把常数抄一遍**）──────
// 让这个人有租户、但**隧道不通**（`proxyFor` 回 `null`）：
//   · 属于他那一份世界的路由 ⇒ 必须 **503 `tenant-not-ready`**（= 宿主**没有**替他答）
//   · 中心的事（账号 / 续期 / 审计 / 空间状态）⇒ 必须**照常 200**（= 不是"什么都坏了"）
//   · 主人（没有租户）⇒ 同一个 `/api/timeline` 必须 **200 且真有帧**（= 这条路由本身是好的）
// ⚠️ 少了最后一条，"把路由整个删掉"也能让第一组变绿 —— 那就是一条只会误报的闸。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Auth } from '../src/auth.js';
import { SayService } from '../src/say.js';
import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';
import { createServer } from '../src/server.js';

/** **必须在他那台盒子里答**的路由（少一个 ⇒ 宿主就可能在替他的世界说话）。 */
const IN_THE_BOX = ['/api/health', '/api/export', '/api/trash', '/api/timeline', '/api/say'];

/** **中心的事**：不许被转发（它们是账号 / 续期 / 审计 / 空间状态那一类）。 */
const CENTER = ['/api/space', '/api/audit'];

const openServers = new Set();
after(async () => {
  for (const close of openServers) {
    try { await close(); } catch { /* 关不干净不影响结论 */ }
  }
  openServers.clear();
});

/** 起一台宿主，一个租户用户（`u2` → `hupo-b`）**隧道不通**，主人走本机。 */
async function serve(t) {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-troutes-'));
  const store = new Store({ dataDir, fsync: false });
  const timeline = new Timeline({ id: 'main', store });
  // 主人那一份里放一句真的（最后一条负向对照要用它）
  timeline.emit({ type: 'user/echo', messageId: 'u_host', text: '主人在本机说的一句', at: 1 });

  const authDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-troutes-auth-'));
  const auth = new Auth({ dataDir: authDir });
  const password = '这一份判据用的口令';
  auth.setPassword(password);

  const { listen, close } = createServer({
    timeline, store, auth,
    say: new SayService({ timeline, store, timelineId: 'main' }),
    trash: null,
    webRoot: null,
    buildId: 't',
    // ★ 数据面：`u2` 有租户、但隧道**不通**（`proxyFor` 回 null）
    tenantOf: (sub) => (sub === 'u2' ? 'hupo-b' : null),
    proxyFor: () => null,
    tenantStatusOf: () => ({ kind: 'tenant', state: 'ready', hasKey: true }),
    isLocalUser: (sub) => sub === 'owner',
    auditFile: null,
  });
  const guarded = async () => { openServers.delete(guarded); await close(); };
  openServers.add(guarded);
  t.after(guarded);
  const addr = await listen(0);
  const origin = `http://127.0.0.1:${addr.port}`;
  const tokenFor = async (sub) => auth.issue({ sub }).token;
  return { origin, tokenFor };
}

/** 拿一个"能走到转发那一步"的请求（GET 无体；POST 给一个空对象）。 */
const reqFor = (url, token, method = 'GET') =>
  fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });

test('有容器的人：属于他自己那一份世界的路由，**宿主一个都不许代答**', async (t) => {
  const { origin, tokenFor } = await serve(t);
  const token = await tokenFor('u2');
  for (const p of IN_THE_BOX) {
    const method = p === '/api/say' ? 'POST' : 'GET';
    const r = await reqFor(`${origin}${p}`, token, method);
    const body = await r.json().catch(() => ({}));
    assert.equal(r.status, 503, `${p} 必须 503（隧道不通时如实说"你那台还在准备"），实际 ${r.status}`);
    assert.equal(body.error, 'tenant-not-ready', `${p} 的错因必须是 tenant-not-ready（不是宿主替他答）`);
  }
});

test('🔴 反面：漏掉一个就会替他答（这一条钉着 2026-09-23 那个真缺陷）', async (t) => {
  const { origin, tokenFor } = await serve(t);
  const token = await tokenFor('u2');
  // `/api/timeline` 就是当时漏掉的那一个：修之前这里拿到的是 **200 + 空帧**
  // （客户端于是说"没有更早的了"），修之后必须是 503。
  const r = await reqFor(`${origin}/api/timeline?before=999&limit=5`, token);
  assert.equal(r.status, 503, '宿主**不许**用自己那份空的盘替他答');
  const body = await r.json();
  assert.equal(body.frames, undefined, '正常答案的字段（frames）一个都不许出现');
});

test('中心的事照旧（证明上面那些 503 不是"什么都坏了"）', async (t) => {
  const { origin, tokenFor } = await serve(t);
  const token = await tokenFor('u2');
  for (const p of CENTER) {
    const r = await reqFor(`${origin}${p}`, token);
    assert.equal(r.status, 200, `${p} 是中心的事，必须照常答（实际 ${r.status}）`);
  }
});

test('主人（没有租户）走本机：`/api/timeline` 200 而且真有帧', async (t) => {
  const { origin, tokenFor } = await serve(t);
  const token = await tokenFor('owner');
  const r = await reqFor(`${origin}/api/timeline?before=999&limit=10`, token);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.frames) && j.frames.length >= 1, '主人那一份本来就有帧 —— 空的说明路由坏了');
  assert.equal(j.frames[0].type, 'user/echo');
});

test('没令牌 ⇒ 401（这一条口不是公开的）', async (t) => {
  const { origin } = await serve(t);
  const r = await fetch(`${origin}/api/timeline?before=999`);
  assert.equal(r.status, 401);
});
