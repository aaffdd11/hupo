// **焦点那本账**（契约 `docs/dev/100-DISPATCHER-D.md` §6.1·补 · 判据 **D-9**）。
//
// ── 为什么要有它（C 期那半条的缺陷）────────────────────────────
// C 期的 `Dispatcher.focusScope` 是"**最后被告知的那一个**"：多设备时会被
// 后连上来的覆盖 —— 于是 `/api/say`（HTTP，看不到那条流）会拿**另一台设备的**
// 焦点来判"他是不是在看这一间"，**该反问的时候不反问**（那是"页面在说假话"的形状）。
//
// 主人 2026-09-25 拍的是**「甲」**：**按连接/设备记**，而"答不准就标 `unknown`"
// **叠加**在上面（甲乙不是二选一）。这个文件就是甲那半。
//
// ── 三条不许破（§6.1·补）─────────────────────────────────────
//   ① **每个人一份**（`world.js` 按人建一个）——不是宿主全局；
//   ② **设备标识是可选加的字段**：老客户端一个字都不改（不带 ⇒ 老行为，
//      见 `resolveFocus` 的 `fallback` 那一档）；
//   ③ **`unknown` 不等于"无所不知"**：它只表示"这一份说不准"，
//      **不许**拿"最新那台的"顶替 —— 用到它的地方按"不知道"处理（该问就问）。
//
// ⚠️ **它不是安全边界**：设备标识由客户端给，只是个**标签**。
//    这里关心的从来不是"你是谁"，而是"这一份焦点说不说得准"。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 答不准时那个值。**它是机器认的档**，不是给人看的话（人话在 `focus.js`）。 */
export const FOCUS_UNKNOWN = 'unknown';

/** 这一格存哪（**跟人走**）。 */
export function focusBookPath(dir) {
  return nodePath.join(dir, 'focus.json');
}

/**
 * **这一份焦点答得准不准**（纯函数 —— 判据的正身就是它）。
 *
 * 三档（`100` §6.1·补 逐字）：
 *   · **没带设备标识** ⇒ `fallback`（= C 期那份"最后被告知的那一个"）
 *     —— **老行为一个字不变**（协议只加可选字段，老客户端就不带）；
 *   · **带了设备标识、但那台没告知过** ⇒ `unknown` —— **不许**拿别的设备的顶替，
 *     哪怕"别的设备说法一致"也不行（这台自己的说法**就是没有**）；
 *   · **那台告知过** ⇒ 它自己那一份（**准**）。
 *
 * ⚠️ 多台各说各的**不会**互相顶替：每台问到的都是**它自己**那一份
 *    （这正是"按连接/设备记"要修掉的那个"最后被告知的那一个"）。
 *
 * @param {object} o
 * @param {string|null} [o.device] 请求上带的设备标识（可不给）
 * @param {Record<string, string>} [o.byDevice] 已记下的 `设备 → 焦点`
 * @param {string|null} [o.fallback] 没带设备标识时用的那一份（C 期语义）
 * @returns {{scope: string|null, known: boolean}} `known:false` ⇒ `scope` 无意义
 */
export function resolveFocus({ device = null, byDevice = {}, fallback = null } = {}) {
  const d = typeof device === 'string' ? device.trim() : '';
  // ① **没带设备标识** ⇒ C 期那一份（协议只加字段，老客户端一个字不改）
  if (d === '') return { scope: typeof fallback === 'string' && fallback !== '' ? fallback : null, known: true };
  const table = byDevice && typeof byDevice === 'object' ? byDevice : {};
  // ② **这台告知过** ⇒ 它自己那一份（准）
  if (Object.prototype.hasOwnProperty.call(table, d)) {
    const s = table[d];
    return { scope: typeof s === 'string' && s !== '' ? s : null, known: true };
  }
  // ③ **这台从没告知过** ⇒ 不知道。**不许**拿"最新那台"或"别的合起来一致"的顶替。
  return { scope: null, known: false };
}

/**
 * **焦点那本账**（`设备 → 焦点` · **一个人一份** · 落盘）。
 *
 * ⚠️ **为什么落盘**：服务重启之后"他刚才在看哪一间"不该变成"从来没告知过"
 *    —— 那会让第 16 条那条反问**多问一句**（多问比乱送好，但没必要）。
 * ⚠️ 写的是**一整个 JSON**（原子换名）：这张表很小，而且**没有历史**可言
 *    （焦点就是"现在"）。
 */
export class FocusBook {
  #dir;
  #file;
  #log;
  #byDevice = Object.create(null);

  constructor({ dir, log = () => {} } = {}) {
    if (!dir) throw new Error('FocusBook 需要 dir');
    this.#dir = dir;
    this.#log = log;
    this.#file = focusBookPath(dir);
    this.#load();
  }

  get path() {
    return this.#file;
  }

  #load() {
    try {
      const raw = nodeFs.readFileSync(this.#file, 'utf8');
      const obj = JSON.parse(raw);
      const t = obj?.devices;
      if (t && typeof t === 'object') {
        for (const [k, v] of Object.entries(t)) {
          if (typeof v === 'string' && v !== '') this.#byDevice[k] = v;
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') this.#log(`焦点那本账没读出来：${err?.message ?? err}`);
    }
  }

  #save() {
    const tmp = `${this.#file}.tmp`;
    try {
      nodeFs.mkdirSync(this.#dir, { recursive: true });
      nodeFs.writeFileSync(tmp, `${JSON.stringify({ v: 1, devices: this.#byDevice })}\n`);
      nodeFs.renameSync(tmp, this.#file);
    } catch (err) {
      // ⚠️ 存不下去**不许**把连接带走：焦点是旁路，下一次告知会再写一遍。
      this.#log(`焦点没存下去：${err?.message ?? err}`);
    }
  }

  /**
   * 告知一次焦点。
   * @param {string|null} device 设备标识（**可不给** —— 老客户端就不给）
   * @param {string} scope
   */
  set(device, scope) {
    const d = typeof device === 'string' ? device.trim() : '';
    const s = typeof scope === 'string' ? scope.trim() : '';
    if (d === '' || s === '') return null;
    this.#byDevice[d] = s;
    this.#save();
    return s;
  }

  /** 已知的那些设备（诊断 / 判据用）。 */
  devices() {
    return { ...this.#byDevice };
  }

  /** 盘上那份原样（判据用）。 */
  raw() {
    return { v: 1, devices: this.devices() };
  }
}
