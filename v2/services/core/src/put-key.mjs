// **盒子里放一把钥匙**（契约 `docs/dev/46-KEY-DELIVERY.md` §三.1）。
//
//   用法（在**宿主**上，盒子里的 node 在 `/bin/node`；盒子里**没有 `/bin/sh`**）：
//
//     podman exec -i hupo-tenant-hupo-a /bin/node /app/code/src/put-key.mjs
//     然后粘钥匙、回车、Ctrl-D
//
//   ⚠️ 它**以 root 跑**（`podman exec` 默认就是 root）：钥匙文件是 `0600 root`，
//      而 agent 是 **uid 1000** ⇒ 它读不到（决策 ① 没动，见契约 §2.1）。
//
//   ⚠️ **不用重启任何东西**：盒里那个小代理是**每次请求现读**那个文件的。
//
//   ⚠️ **它不回显钥匙、不写日志**（只回一句"放在哪"）。

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { credNameOf, credValueOk, isCredField } from './creds.mjs';
import { writeKeyFile } from './tenant-shell.mjs';
import { keyFileFor } from './key-path.mjs';

// ⚠️ 规则住在 `key-path.mjs`（**只有那一处**）—— 这里 re-export 只是让调用方少 import 一个。
export { keyFileFor };

/**
 * 读进来、检查、写下去。**纯逻辑抽出来**（`test/unit` 里能逐条验）。
 *
 * ⚠️ **默认还是 `model`**（老命令行行为逐字不变）；要放别的字段就给 `field`
 *    （命令行上是 `HUPO_KEY_FIELD`）。写下去走 `writeKeyFile` ⇒ **合并**，
 *    不许整文件覆盖（2026-09-23：别把别人放的那几把抹掉）。
 *
 * @param {{raw?:string, field?:string, keyFile?:string, fs?:import('node:fs')}} [o]
 * @returns {{ok:true, file:string}|{ok:false, why:string}}
 */
export function putKey({ raw, field = 'model', keyFile, fs = nodeFs } = {}) {
  if (!isCredField(field)) return { ok: false, why: `认不出这个字段名：${JSON.stringify(field)}` };
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length === 0) return { ok: false, why: '没读到东西（要粘一把钥匙进来，然后 Ctrl-D）' };
  // 和网页那条路**同一条规矩**：HTTP 头带不走的字符就不要（规则住在 `creds.mjs`）
  if (!credValueOk(key)) return { ok: false, why: '里面有不可打印的字符（多半是粘错了）' };
  if (key.length > 4096) return { ok: false, why: '太长了，不像一把钥匙' };
  try {
    writeKeyFile(keyFile, key, { field, fs });
  } catch (err) {
    return { ok: false, why: `写不进去：${err?.code ?? err?.message ?? err}` };
  }
  return { ok: true, file: keyFile };
}

/** 真正跑起来（被 `node put-key.mjs` 直接执行时）。 */
export async function main({ env = process.env, fs = nodeFs, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const keyFile = keyFileFor(env);
  // ⚠️ **可选**：不给就是 `model`（老用法一个字都不用改）。认不出的名字**当场拒**，
  //    不许悄悄当成 model —— 那样"放图片那把"会覆盖掉语言那把。
  const field = env.HUPO_KEY_FIELD ?? 'model';
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  const r = putKey({ raw: Buffer.concat(chunks).toString('utf8'), field, keyFile, fs });
  if (!r.ok) {
    stderr.write(`✗ ${r.why}\n`);
    return 2;
  }
  let mode = '?';
  let who = '?';
  try {
    const st = fs.statSync(keyFile);
    mode = (st.mode & 0o777).toString(8);
    who = String(st.uid);
  } catch {
    /* 不显示具体值也不影响结论 */
  }
  // ⚠️ **只说"放在哪、权限对不对"，一个字符的钥匙都不回显**
  stdout.write(`✓ 钥匙放好了：${keyFile}（${who}:${mode}）\n`);
  stdout.write('  盒里那个小代理每次请求都会现读它 ⇒ **不用重启**。\n');
  stdout.write(`  （字段名 ${credNameOf(field)}；agent 是 uid 1000，它读不到这个文件。）\n`);
  return 0;
}

// ── 直接跑 ────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`✗ 放钥匙那一步出错了：${err?.message ?? err}\n`);
      process.exit(3);
    },
  );
}
