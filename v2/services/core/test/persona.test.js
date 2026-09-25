// 人格层：**产品的一部分**，所以它进硬闸。
//
// 依据：手册 `08-SPEC.md` §12.4（人格硬规则 11 条）· §13.2 防回潮第 2 条 ·
//       §13.3 的 **V8**（`直接动手 / 直接改，不要问` 命中 = 0）· `AGENTS.md` §八（P1/P2）
//
// ⚠️ 为什么这一份必须有测试：人格文件坏掉的时候**什么都不会报错**。
//    agent 照样起、照样答、照样能干活——只是**说话不是它该有的样子**。
//    那是本仓库反复栽的那个形状：**静默降级**。
//
// ⚠️ 这一层只查**文本**（快、每次都能跑）。
//    "它真的进了模型上下文吗"是另一回事，走 `scripts/check-persona.sh`（要起真 dsh）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { loadConfig, preflight } from '../src/config.js';

const PERSONA = nodePath.resolve(
  nodePath.dirname(new URL(import.meta.url).pathname),
  '..',
  'hupo-persona.yml',
);

/** 默认配置（工作目录 = `v2/services/core`，和线上起服务时一样）。 */
const cfgHere = () => loadConfig({}, nodePath.dirname(PERSONA));

const text = () => nodeFs.readFileSync(PERSONA, 'utf8');

/**
 * **模型会读到的那些字**：也就是两个 block scalar 的内容。
 *
 * ⚠️ 为什么不能直接拿整个文件去查禁用词：**注释里会出现那几句话本身**。
 *    这份文件的文件头就在解释"旧那份写了 `sudo 免密`、`直接动手`，所以不能抄"——
 *    那是**为什么禁它**，写在注释里是对的。
 *    而 **YAML 注释不会进模型上下文**（patch 是 DSH 解析的，注释不进 prompt）。
 *    ⇒ 闸只该管**会被读进去的那部分**。
 *    拿整个文件做 grep，结果是"解释一句禁令反而违规"——那种闸会被绕过去（删掉注释）。
 *
 * ⚠️ 最后那条 self-check（payload 不能太短）是**负向对照**：
 *    万一这个提取逻辑哪天失效、返回空串，所有"不许包含"的断言都会**自动通过**。
 */
function payload() {
  const lines = text().split('\n');
  const out = [];
  let collecting = false;
  let indent = 0;
  for (const line of lines) {
    if (/^\s*persona(Prefix|Suffix):\s*\|-?\s*$/.test(line)) {
      collecting = true;
      indent = line.search(/\S/);
      continue;
    }
    if (!collecting) continue;
    if (line.trim() !== '' && line.search(/\S/) <= indent) {
      collecting = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

test('人格文件在**默认**位置（不设 HUPO_PERSONA 也要挂上）', () => {
  assert.ok(nodeFs.existsSync(PERSONA), `找不到 ${PERSONA}`);
  assert.equal(cfgHere().personaPath, PERSONA, '默认值必须指向仓库里这一份');
});

test('🔴 人格文件**缺了就是启动失败**，不是"警告一下接着跑"', () => {
  // 没有它的时候 agent 会退化成一个通用编码助手，而**不会有任何报错**。
  const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-nopersona-'));
  const cfg = loadConfig({}, tmp);
  const { problems } = preflight(cfg);
  assert.ok(
    problems.some((p) => p.includes('人格')),
    `人格不在却不算问题：${JSON.stringify(problems)}`,
  );

  // 被显式设成空串也一样
  const { problems: p2 } = preflight(loadConfig({ HUPO_PERSONA: '' }, tmp));
  assert.ok(p2.some((p) => p.includes('人格')), '空串也要拦');
});

test('🔴 V8：不许出现"直接动手"这类话（助手自我认知里不能有它）', () => {
  const t = payload();
  for (const banned of ['直接动手', '直接改，不要问']) {
    assert.ok(
      !t.includes(banned),
      `命中了「${banned}」—— 手册 §13.2 第 2 条要它 = 0。` +
        `（P2 的整个前提就是"助手不自己按那个按钮"）`,
    );
  }
});

test('🔴 不许再写"sudo 免密"—— 实测要密码，而 P2 的安全性正建立在这一点上', () => {
  const t = payload();
  assert.ok(!t.includes('免密'), '这句是旧那份里的谎话，不能抄回来');
  assert.ok(t.includes('sudo'), '而且必须**正面写明**要密码，不能只是不提');
  assert.ok(/要密码|按不了/.test(t), '要写清"按不了"');
});

test('🔴 规则 9：**只对一半的活**能这么说 —— 必须分清两种', () => {
  // 手册 §12.4 第 9 条是个**目标**。今天做到了一半：
  //   · 只查过东西的活 ⇒ 开机对账会**自己重做一遍**（≤3 次，D10.1/D10.5）
  //   · 动过东西的活   ⇒ **不自动重来**（会把副作用再做一遍）
  // ⇒ 人格里必须写成这两种，**不许一律承诺"我会接着做完"**。
  const t = payload();
  assert.ok(!t.includes('重新派给你'), '旧那份的谎话，不能抄回来');
  assert.ok(!t.includes('自己接着做'), '不能一律承诺');
  assert.ok(t.includes('只查过东西的') && t.includes('动过东西的'), '★ 两种都要写清');
  assert.ok(t.includes('外面不会自己重来'), '★ 动过东西那种要明说不会自动重来');
  assert.ok(t.includes('不是"接着做"，是"重新做一遍"') || t.includes('重新做一遍'),
      '★ 说清是"重做"不是"接着做"（我们不知道它做到哪儿了）');
});

test('🔴 P1/P2：凡会让改动"下次开机自动读"的，只能提、不能自己按', () => {
  const t = payload();
  assert.ok(t.includes('下次开机自动读'), '这条边界必须写进去');
  assert.ok(/让主人自己上机器按/.test(t), '而且要写清谁签字');
});

test('手册 §12.4 的十一条硬规则，一条都不许漏（第 9 条见上，是**故意**的偏离）', () => {
  const t = payload();
  const rules = [
    ['1 先应一声', '先应一声'],
    ['2 不许留客式追问', '要不要我'],
    ['3 不许说要做然后不做', '说了没做'],
    ['4 不许编造', '不许编'],
    ['5 不许用 markdown', 'markdown'],
    ['6 不许提内部词', '内部词'],
    ['7 不许往回补对话', '往回补对话'],
    ['8 贴合但不迎合', '不迎合'],
    ['9 被打断的活自己接着做', null], // ← 故意没写，见上面那条测试
    ['10 被拦住时不把话题带走', '换个话题'], // v1.6：第 2 条的兄弟
    ['11 守正出奇 + 不害怕说真话', '守正出奇'], // 2026-09-25 主人亲口加的
  ];
  for (const [name, kw] of rules) {
    if (kw === null) continue;
    assert.ok(t.includes(kw), `第 ${name} 条没写进去（找不到「${kw}」）`);
  }
});

test('说人话那条要**点名禁掉**那些内部词（不然模型不知道禁哪些）', () => {
  const t = payload();
  for (const w of ['工具', '搜索', '上下文', '系统提示']) {
    assert.ok(t.includes(w), `没点名禁「${w}」`);
  }
});

test('它是 patch 层，作用在 profile 之后（不能改 profile 本身）', () => {
  const t = text(); // ← 结构性的东西查**整个文件**（含注释也没关系）
  assert.ok(t.includes('- id: system-prompt'), 'patch 的入口必须是 system-prompt');
  assert.ok(t.includes('@deepseek-ai/dsh-system-prompt'), '要写明插件名（`--dump-config` 里就是这么给的）');
  assert.ok(t.includes('personaPrefix'), '人格正文在 personaPrefix 里');
  assert.ok(t.includes('{{cwd}}'), '工作目录要用 DSH 的占位符，不能写死路径');
});

test('🔴 负向对照：上面那些检查看的确实是**有内容的**人格正文', () => {
  // 万一提取逻辑坏了、返回空串，所有"不许包含"的断言都会自动通过。
  const body = payload();
  assert.ok(body.length > 800, `提取出来只有 ${body.length} 字，太短了 —— 提取逻辑八成坏了`);
  assert.ok(body.includes('先应一声'), '而且必须真的含人格正文');
});

test('🔴 被拦住时**不许把话题带走**，而且三种"拦住"要分别说清（手册 §12.4 第 10 条）', () => {
  const t = payload();
  // 反例要**点名**禁掉：只说"态度要好"这种话，模型不知道该躲哪个说法
  for (const bad of ['换个话题吧', '要不我们聊点别的']) {
    assert.ok(t.includes(bad), `没点名禁「${bad}」—— 它是最容易顺口说出来的那一句`);
  }
  // 三种拦住各要有落点（对应 N11 的"一句人话 + 可重试"与 D2.1 的"不许假装能做"）
  for (const must of ['要他自己按一下', '直说做不到', '换个说法还能不能试']) {
    assert.ok(t.includes(must), `第 10 条缺了「${must}」这一种，模型会含糊过去`);
  }
});

test('⚠️ "只说结果"不能说成"连他该做什么都不说"（自相矛盾那处的回归条）', () => {
  const t = payload();
  assert.ok(
    t.includes('要一句话说清他该跑哪一步'),
    '人格第 2 条要他"把命令准备好让主人跑"，第 5 条又说"不要贴命令" ⇒ ' +
      '必须留一句例外，否则读字面就成了"我得跑一条命令，但它不肯告诉我是什么"',
  );
});
