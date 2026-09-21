// **自动开一台**：命名模板 + 申请队列（契约 `docs/dev/43-AUTO-PROVISION.md`）。
//
// ── 这一份钉的是**安全模型那几条不变量**（不是"功能对不对"）──────
//   A1 🔴 申请的文件是**空的** —— 服务绝不往里面写任何东西；
//   A2 🔴 名字/uid **只由模板从 `n` 推出来**，推不出就 `null`（**不猜**）；
//   A3 🔴 投申请**不许跟着符号链接**写到别处去；
//   A4 **幂等**：同一个 `n` 投两次只有一张申请；
//   A5 **失败要留标记**（不然失败的人会在等待屏上永远等下去）。
//
// ⚠️ 特权侧（`scripts/provision-tenant-request.sh`）的判据**不在这里**：
//    它要 root、要真建用户 ⇒ 归 `scripts/check-provision-refusals.sh`（只验"拒"的那一半）。
//    这一份只验**服务侧算出来的东西** —— 那才是纯的、能逐档钉的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import {
  NO_TENANT_TEMPLATE,
  OWNER_ID,
  parseTenantTemplate,
  readTenantTemplate,
  tenancyFor,
  tenantNameFor,
  tenantUidFor,
  userIdNumber,
} from '../src/tenants.js';
import { ProvisionQueue, requestFileName } from '../src/provision.js';

// ⚠️ 这一份模板是**照着 `tenant-template.conf` 手抄的** —— 抄错这条闸就白设了。
//    所以下面另有一条"读真文件"的用例（`readTenantTemplate`），两边一起看才有意义。
const TPL = Object.freeze({ namePrefix: 'hupo-t', uidBase: 3000, maxTenants: 8, ok: true });

function tmpdir() {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-prov-'));
}

// ══════════════════════════════════════════════════════════════════════
// ① 模板解析：**多一个键就是错**（防"悄悄加旋钮"，那时两边又漂了）
// ══════════════════════════════════════════════════════════════════════

test('模板：三行都合法 ⇒ ok', () => {
  const t = parseTenantTemplate('name_prefix=hupo-t\nuid_base=3000\nmax_tenants=8\n');
  assert.equal(t.ok, true);
  assert.equal(t.namePrefix, 'hupo-t');
  assert.equal(t.uidBase, 3000);
  assert.equal(t.maxTenants, 8);
});

test('🔴 模板：出现不认识的键 ⇒ 抛（不是忽略）', () => {
  assert.throws(
    () => parseTenantTemplate('name_prefix=hupo-t\nuid_base=3000\nmax_tenants=8\n给点面子=1\n'),
    /不认识的键/,
  );
});

test('🔴 模板：同一个键写两遍 ⇒ 抛', () => {
  assert.throws(
    () => parseTenantTemplate('name_prefix=hupo-t\nname_prefix=别的\nuid_base=3000\nmax_tenants=8\n'),
    /写了两遍/,
  );
});

test('模板：少了任何一行 ⇒ ok 为假（**不许**拿默认值凑）', () => {
  assert.equal(parseTenantTemplate('name_prefix=hupo-t\nuid_base=3000\n').ok, false);
  assert.equal(parseTenantTemplate('').ok, false);
  assert.equal(NO_TENANT_TEMPLATE.ok, false);
  assert.equal(NO_TENANT_TEMPLATE.maxTenants, 0, '关着的时候上限必须是 0 —— 谁也别想开');
});

test('模板：前缀/数字不合法 ⇒ 抛', () => {
  assert.throws(() => parseTenantTemplate('name_prefix=Hupo_T\nuid_base=3000\nmax_tenants=8\n'), /不合法/);
  assert.throws(() => parseTenantTemplate('name_prefix=hupo-t\nuid_base=-1\nmax_tenants=8\n'), /不合法/);
  assert.throws(() => parseTenantTemplate('name_prefix=hupo-t\nuid_base=3000\nmax_tenants=abc\n'), /不合法/);
});

test('🔴 读**真**的那一份：仓库里那个文件必须能读出来、而且三行齐', () => {
  // ⚠️ 这条是"手抄的 TPL 抄错了"的对照 —— 少了它，上面那些用例可以在一个
  //    与生产**不一样**的模板上全绿（这个项目吃过这种亏：闸打在错的输入上）。
  const real = readTenantTemplate();
  assert.equal(real.ok, true, 'tenant-template.conf 读不出来或者少行');
  assert.equal(real.namePrefix, TPL.namePrefix);
  assert.equal(real.uidBase, TPL.uidBase);
  assert.equal(real.maxTenants, TPL.maxTenants);
});

test('模板：文件不在 ⇒ 这条路**关着**（不是抛、也不是猜一个默认值）', () => {
  const t = readTenantTemplate({ file: '/definitely/not/here.conf' });
  assert.equal(t.ok, false);
  assert.equal(t.maxTenants, 0);
});

// ══════════════════════════════════════════════════════════════════════
// ② 从 `n` 推名字（A2）：**推不出来就 null**，绝不含糊
// ══════════════════════════════════════════════════════════════════════

test('userIdNumber：只认 u1…u999 这个形状', () => {
  assert.equal(userIdNumber('u1'), 1);
  assert.equal(userIdNumber('u12'), 12);
  assert.equal(userIdNumber('u999'), 999);
  // 下面这些**都认不出**（拿它们去推名字 = 路径穿越/越界的入口）
  for (const bad of [OWNER_ID, 'u0', 'u01', 'u-1', 'u1a', 'u', '', 'u1000', 'u 3', null, 3]) {
    assert.equal(userIdNumber(bad), null, `${JSON.stringify(bad)} 不该被认出来`);
  }
});

test('租户名/uid：由模板推出来（服务侧与 shell 侧读的是**同一个模板文件**）', () => {
  assert.equal(tenantNameFor('u3', TPL), 'hupo-t3');
  assert.equal(tenantUidFor('u3', TPL), 3003);
  assert.equal(tenantNameFor('u8', TPL), 'hupo-t8');
  assert.equal(tenantUidFor('u8', TPL), 3008);
});

test('🔴 超过上限 ⇒ null（**不许**推出上限外的名字）', () => {
  assert.equal(tenantNameFor('u9', TPL), null);
  assert.equal(tenantUidFor('u9', TPL), null);
  assert.equal(tenantNameFor('u3', NO_TENANT_TEMPLATE), null, '模板关着 ⇒ 一个都不许推');
});

test('tenancyFor：四种实情分得开', () => {
  const map = new Map([['u1', 'hupo-a']]);
  assert.equal(tenancyFor(OWNER_ID, { map, tpl: TPL }), 'local');
  assert.equal(tenancyFor('u1', { map, tpl: TPL }), 'mapped');
  assert.equal(tenancyFor('u3', { map, tpl: TPL }), 'provisionable');
  assert.equal(tenancyFor('u9', { map, tpl: TPL }), 'full');
  assert.equal(tenancyFor('u3', { map, tpl: NO_TENANT_TEMPLATE }), 'full');
});

test('🔴 静态表**优先**：u1 在表里 ⇒ 推出来的名字不该被当成答案', () => {
  // ⚠️ 这条钉的是一个**会静默毁掉老用户**的坑：`tenantNameFor('u1')` 是 `hupo-t1`，
  //    而真在跑的那台叫 `hupo-a`。服务要是拿推出来的那个名字去听通道，
  //    现象是"主人自己那台好好的、老用户全连不上"。
  //    ⇒ 真相在 `serve.js` 的 `tenantOf = 表 ?? 推`，这里只钉"两个名字确实不同"。
  assert.equal(tenantNameFor('u1', TPL), 'hupo-t1');
  assert.notEqual(tenantNameFor('u1', TPL), 'hupo-a');
});

// ══════════════════════════════════════════════════════════════════════
// ③ 申请队列（A1 / A3 / A4 / A5）
// ══════════════════════════════════════════════════════════════════════

test('申请文件的名字：只由整数来', () => {
  assert.equal(requestFileName(3), '3.req');
  assert.equal(requestFileName(0), null);
  assert.equal(requestFileName(-1), null);
  assert.equal(requestFileName(1.5), null);
  assert.equal(requestFileName('3'), null);
});

test('🔴 A1：投出去的申请是**空文件** —— 一个字节都不许有', () => {
  const dir = tmpdir();
  const q = new ProvisionQueue({ dir });
  assert.equal(q.available, true);
  const r = q.request('u3');
  assert.equal(r.ok, true);
  assert.equal(r.why, 'asked');
  const p = nodePath.join(dir, '3.req');
  assert.equal(nodeFs.existsSync(p), true);
  // ★ 这一条就是 A1 本身：**内容为空**（手机号/key/路径/命令，一个都不许进这个文件）
  assert.equal(nodeFs.readFileSync(p).length, 0, '申请里出现了内容 —— 边界破了');
});

test('A4：同一个 n 投两次 ⇒ 只有一张申请，而且第二次说 already', () => {
  const dir = tmpdir();
  const q = new ProvisionQueue({ dir });
  assert.equal(q.request('u3').why, 'asked');
  assert.equal(q.request('u3').why, 'already');
  assert.deepEqual(nodeFs.readdirSync(dir), ['3.req'], '多出来的文件说明投重了');
});

test('A4：不同的 n 各投各的；`owner` 那种认不出的 id 直接拒', () => {
  const dir = tmpdir();
  const q = new ProvisionQueue({ dir });
  assert.equal(q.request('u3').ok, true);
  assert.equal(q.request('u4').ok, true);
  assert.deepEqual(nodeFs.readdirSync(dir).sort(), ['3.req', '4.req']);
  assert.equal(q.request(OWNER_ID).why, 'bad-id');
  assert.equal(q.request('u0').why, 'bad-id');
});

test('🔴 助手没装（目录不在）⇒ 如实说 no-helper，**不许**假装投出去了', () => {
  const q = new ProvisionQueue({ dir: '/definitely/not/here' });
  assert.equal(q.available, false);
  const r = q.request('u3');
  assert.equal(r.ok, false);
  assert.equal(r.why, 'no-helper');
});

test('🔴 A3：名字上已经有个**符号链接** ⇒ 绝不跟着它写到别处去', () => {
  const dir = tmpdir();
  const victim = nodePath.join(tmpdir(), 'victim.txt');
  nodeFs.writeFileSync(victim, '本来是这样');
  nodeFs.symlinkSync(victim, nodePath.join(dir, '3.req')); // 攻击者摆好的那一下

  const q = new ProvisionQueue({ dir });
  const r = q.request('u3');
  // ⚠️ `wx` 撞上已存在的（哪怕是符号链接）⇒ 报 already；**关键是下面这一条**：
  assert.equal(nodeFs.readFileSync(victim, 'utf8'), '本来是这样', '被写穿了 —— 边界破了');
  assert.equal(r.ok, true, '当成"已经有一张了"就行，反正特权侧会拒那个符号链接');
});

test('🔴 A5：`outstanding` 只认**普通文件**（一个符号链接不算"在飞"）', () => {
  const dir = tmpdir();
  const q = new ProvisionQueue({ dir });
  assert.equal(q.outstanding('u3'), false);
  q.request('u3');
  assert.equal(q.outstanding('u3'), true);
  // 换成符号链接 ⇒ 不算（否则一个坏文件能把状态永远骗成"正在开"）
  nodeFs.rmSync(nodePath.join(dir, '3.req'));
  nodeFs.symlinkSync('/etc/hostname', nodePath.join(dir, '3.req'));
  assert.equal(q.outstanding('u3'), false);
});

test('🔴 A5：失败标记 —— 有它才算"建不了"，没有就是"还没建/正在建"', () => {
  const dir = tmpdir();
  const q = new ProvisionQueue({ dir });
  assert.equal(q.failed('u3'), false);
  nodeFs.writeFileSync(nodePath.join(dir, '3.req.failed'), '');
  assert.equal(q.failed('u3'), true);
  // ⚠️ 符号链接冒充失败标记 ⇒ 不算（同 outstanding 那条道理）
  const dir2 = tmpdir();
  const q2 = new ProvisionQueue({ dir: dir2 });
  nodeFs.symlinkSync('/etc/hostname', nodePath.join(dir2, '3.req.failed'));
  assert.equal(q2.failed('u3'), false);
});
