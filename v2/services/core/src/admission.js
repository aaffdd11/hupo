// **准入闸**：满了就**明确拒绝**（手册 `08-SPEC.md` **§9.1** / **§10.3**）。
//
// 判据是**内存占用比**：`memory.current / memory.max ≥ 0.75` ⇒ **拒新会话**。
// 手册原话："留 25% 给握手峰值与监控 agent"。
// 而且同一节还写着："**没有计数闸**（不给数字，所以判据只能是内存）"
// —— ⇒ **别去加"同时 N 个会话就拒"这种闸**：那是在给一个我们不承诺的数字上锁。
//
// 拒绝必须三件（N11 + §9.1）：**一句人话 + 可重试 + 不建空 jsonl 文件**。
// ⇒ 所以判的位置很要紧：必须在**落盘之前**（`server.js` 的 `handleSay` 里、`say.say()` 之前）。
//   落盘之后再拒，就是"文件已经建了"，而下一个人根本分不清
//   **"没收下"**和**"收下了但没答"**——那两种在日志里长得一模一样。
//
// ⚠️ **这台机器现在算不出这个判据**（实测）：服务跑在一个 `dsh-subprocess-*.scope` 里，
//    从它自己到 `/user.slice` **每一层的 `memory.max` 都是 `max`**。
//    手册那个 0.75 是**有上限时**才算得出来的相对量。
//    ⇒ 那种情况下**不许悄悄放行**（"看起来有闸、其实没有"），
//      要像完整性清单那样**如实说"这道闸现在算不出判据"**（横幅里写出来）。
//      等容器/单元那次 `sudo` 落地（`MemoryMax=1G`），它自然就活了。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/**
 * 准入阈值。**这个数字来自手册**（§9.1 与 §10.3 都写着 0.75），
 * 不是这里拍的 —— 改它之前先改手册。
 */
export const ADMIT_RATIO = 0.75;

/** 从 `/proc/<pid>/cgroup` 的内容里取出 cgroup v2 那条路径。 */
export function cgroupPathFrom(text) {
  // v2 那一行长这样：`0::/user.slice/.../x.scope`
  for (const line of String(text).split('\n')) {
    const m = /^0::(\/\S*)$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

/**
 * 往上找**最近的有限上限**（内核实际生效的就是路径上最小的那个），
 * 并把**同一层**的 `current` 一起取回来当分子。
 *
 * ⚠️ 分子分母必须**同层**：拿我们的 `current` 去除以祖先的 `max`，
 *    会算出一个偏小的比，然后在最该拒的时候放行。
 *
 * @returns {{limitBytes:number|null, usedBytes:number|null, level:string|null}}
 */
export function findLimit({ start, readFile }) {
  if (!start) return { limitBytes: null, usedBytes: null, level: null };
  let dir = start;
  for (;;) {
    const maxRaw = readFile(nodePath.join(dir, 'memory.max'));
    if (maxRaw !== null) {
      const max = Number.parseInt(String(maxRaw).trim(), 10);
      if (Number.isFinite(max) && max > 0) {
        const cur = Number.parseInt(String(readFile(nodePath.join(dir, 'memory.current')) ?? '').trim(), 10);
        return { limitBytes: max, usedBytes: Number.isFinite(cur) ? cur : null, level: dir };
      }
    }
    if (dir === '/' || dir === '') break;
    dir = nodePath.dirname(dir);
  }
  return { limitBytes: null, usedBytes: null, level: null };
}

/**
 * 判（**纯函数**，不碰磁盘 ⇒ 直接进硬闸）。
 *
 * @returns {{ok:boolean, code:'ok'|'no-limit'|'busy', ratio:number|null}}
 */
export function decide({ limitBytes, usedBytes }) {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0 || !Number.isFinite(usedBytes)) {
    // 算不出来 ⇒ **放行，但把这件事说出去**（调用方负责写进横幅）
    return { ok: true, code: 'no-limit', ratio: null };
  }
  const ratio = usedBytes / limitBytes;
  if (ratio >= ADMIT_RATIO) return { ok: false, code: 'busy', ratio };
  return { ok: true, code: 'ok', ratio };
}

/** 读磁盘判一次（`server.js` 每次要接新句子之前走这条）。 */
export function readAdmission({ pid = process.pid, readFile = defaultRead, readProc = defaultReadProc } = {}) {
  const start = cgroupPathFrom(readProc(`/proc/${pid}/cgroup`) ?? '');
  const found = findLimit({ start, readFile });
  return { ...decide(found), ...found };
}

function defaultRead(file) {
  try {
    return nodeFs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function defaultReadProc(file) {
  try {
    return nodeFs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 横幅上那一行要说的话（**如实**：算不出判据就说算不出）。 */
export function describeAdmission(adm) {
  if (adm.code === 'no-limit') {
    return '⚠️ **算不出判据**（这一层没有内存上限 ⇒ 这道闸现在不生效）';
  }
  const limitMb = Math.round(adm.limitBytes / 1024 / 1024);
  const pct = adm.ratio === null ? '?' : Math.round(adm.ratio * 100);
  return `看内存占用比（上限 ${limitMb}M ⇒ ≥${Math.round(ADMIT_RATIO * 100)}% 拒；现在 ${pct}%）`;
}
