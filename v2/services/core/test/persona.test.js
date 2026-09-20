// 人格层：**产品的一部分**，所以它进硬闸。
//
// 依据：手册 `08-SPEC.md` §12.4（人格硬规则 9 条）· §13.2 防回潮第 2 条 ·
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

test('🔴 不许承诺"被打断的活会自己接着做" —— 那个还没做', () => {
  // 手册 §12.4 第 9 条列的是**目标**，而对账续做（`00-PROGRESS.md` 第 ④ 条）**还没建**。
  // ⇒ 现在把它写进人格，等于让助手对主人说一句做不到的话 ——
  //   而那正是手册事故一的形状（"还有件事在处理"挂了 68 分钟）。
  const t = payload();
  assert.ok(!t.includes('重新派给你'), '这是旧那份的谎话');
  assert.ok(!t.includes('自己接着做'), '规则 9 是目标，不是现状');
  // ⚠️ 但**必须说实话**顶上，不许只说"不写"
  assert.ok(t.includes('被重启打断的活就是断了'), '要用实话顶上：断了就直说');
});

test('🔴 P1/P2：凡会让改动"下次开机自动读"的，只能提、不能自己按', () => {
  const t = payload();
  assert.ok(t.includes('下次开机自动读'), '这条边界必须写进去');
  assert.ok(/让主人自己上机器按/.test(t), '而且要写清谁签字');
});

test('手册 §12.4 的九条硬规则，一条都不许漏（第 9 条见上，是**故意**的偏离）', () => {
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
