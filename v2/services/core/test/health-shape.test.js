// **P1-12（2026-09-24）：`/api/health` 的"形状"在手册与代码之间不许漂。**
//
// 为什么要有它：手册 §2.1 那一行原来写着六项（disk / store / agents / memory / upstream / cert），
// 而代码只回三个字段（ok / timelineId / seq）—— `grep upstream|cert server.js` = **0**。
// 也就是说**那一行在说假话**，而没有任何判据会发现（用户看不到，闸也不扫手册）。
// ⇒ 这条判据**两边都读**：手册那一行点名的字段 = 代码那道分支真的回的字段；漂了就红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

const ROOT = nodePath.resolve(import.meta.dirname, '../../../..');
const SPEC = nodePath.join(ROOT, 'docs/handbook/08-SPEC.md');
const SRC = nodePath.join(ROOT, 'v2/services/core/src/server.js');

test('★ P1-12：手册 /api/health 那一行 = 代码真的回的那几个字段', () => {
  const line = nodeFs
    .readFileSync(SPEC, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('| `/api/health`'));
  assert.ok(line, '手册里找不到 /api/health 那一行');

  const src = nodeFs.readFileSync(SRC, 'utf8');
  const m = src.match(/path === '\/api\/health'[\s\S]{0,400}?sendJson\(res, 200, \{([^}]*)\}/);
  assert.ok(m, 'server.js 里找不到 /api/health 那道分支（它搬家了？那这条判据要跟着改）');

  const fields = m[1]
    .split(',')
    .map((s) => s.trim().split(':')[0].replace(/['"]/g, '').trim())
    .filter(Boolean);
  assert.ok(fields.length > 0, '一个字段都没解析出来（正则该修了）');
  for (const f of fields) {
    assert.ok(line.includes(f), `手册那一行没写字段 ${f}（代码真的回它）= 手册在说假话`);
  }
  // 反向：那六项没实现 —— **提到就必须明标「没做」**（⏳），不许又当成已实现的形状写一遍
  if (/disk \/ store/.test(line)) {
    assert.ok(
      /⏳|从来没实现/.test(line),
      '那一行提到了那六项，却没有明标「没做」⇒ 又变成文档在说假话',
    );
  }
});
