// **申请队列（服务侧）** —— 契约 `docs/dev/43-AUTO-PROVISION.md`。
//
// ── 它是这一整套里唯一新增的副作用，所以它故意小到能用眼睛看完 ──────
//   服务（`deploy`）**没有特权**，它开不了别人的容器。
//   它唯一能做的，是往一个目录里**放一个空文件**，名字是一个整数：
//
//       /run/hupo-provision/<n>.req
//
//   root 侧那个助手（`scripts/provision-tenant-request.sh`，由 systemd 按需拉起）
//   只读那个**名字**里的整数，别的什么都不读。
//
// ── 三条不许破（对应契约里的 A1 / A3 / A7）───────────────────
//   ① 🔴 **绝不往申请里写任何内容**：不写手机号、不写 key、不写路径、不写命令。
//      文件是**空的**。这不是"省事"，这是边界本身（A1）。
//   ② **幂等**：已经在飞的申请不重复投（A4）。
//   ③ **失败如实说**：助手没装 ⇒ 这条路由**关着**，调用方必须知道（不许假装投了）。
//
// ⚠️ 它**不建任何东西**：建人/建卷/起容器全在特权侧。这里碰一下特权就是这套设计废了。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { userIdNumber } from './tenants.js';

/** 申请目录。`/run` 是 tmpfs ⇒ 重启即空（在飞的申请由下一次状态查询重新投）。 */
export const DEFAULT_PROVISION_DIR = '/run/hupo-provision';

/**
 * **失败标记放哪**（**不在**申请目录里）。
 *
 * 🔴 为什么非分开不可（2026-09-21 真机量出来的）：`.path` 单元上那句
 *    `DirectoryNotEmpty=` **会反复触发**（探针实测：投放口里留一个文件，
 *    服务被拉起 5 次，然后撞上 systemd 的**启动限速** ⇒ 单元进 `failed`）。
 *    ⇒ 只要投放口里**留下任何东西**（失败标记就是），它就会一直触发，
 *    而"一直触发到限速"的另一面是：**之后的新申请没人管了**。
 *    ⇒ 所以：**投放口里只许有待办申请**；标记住旁边。
 */
export const DEFAULT_FAILED_DIR = '/run/hupo-provision-state';

/** 申请文件的名字。**只认这个形状**（助手那侧也是同一条正则）。 */
export function requestFileName(n) {
  return Number.isSafeInteger(n) && n > 0 ? `${n}.req` : null;
}

export class ProvisionQueue {
  #dir;
  /** 见 `DEFAULT_FAILED_DIR`：标记**不在**申请目录里。 */
  #failedDir;
  #fs;
  #log;
  /** 只抱怨一次"助手没装"，别把日志刷爆 */
  #complained = false;

  constructor({
    dir = DEFAULT_PROVISION_DIR,
    failedDir = DEFAULT_FAILED_DIR,
    fs = nodeFs,
    log = () => {},
  } = {}) {
    this.#dir = dir;
    this.#failedDir = failedDir;
    this.#fs = fs;
    this.#log = log;
  }

  get dir() {
    return this.#dir;
  }

  /** 特权侧装了没有。**只看目录在不在**（它由 `tmpfiles.d` 建）。 */
  get available() {
    try {
      return this.#fs.statSync(this.#dir).isDirectory();
    } catch {
      return false;
    }
  }

  #pathFor(userId) {
    const n = userIdNumber(userId);
    const name = requestFileName(n);
    return name ? nodePath.join(this.#dir, name) : null;
  }

  /**
   * 投一张申请（**幂等**）。
   * @returns {{ok:boolean, why:'asked'|'already'|'bad-id'|'no-helper'|'failed'}}
   */
  request(userId) {
    const p = this.#pathFor(userId);
    if (!p) return { ok: false, why: 'bad-id' };
    if (!this.available) {
      if (!this.#complained) {
        this.#complained = true;
        this.#log(
          `  ⚠️ 申请目录不在（${this.#dir}）⇒ **"自动开一台"这条路关着**：` +
            '新号只能排队。装上特权侧那条路：sudo bash scripts/install-provision-helper.sh --yes',
        );
      }
      return { ok: false, why: 'no-helper' };
    }
    if (this.outstanding(userId)) return { ok: true, why: 'already' };
    try {
      // ⚠️ `wx` = **只在不存在时创建**。它同时挡住"跟着符号链接去写别处"：
      //    路径上已经有个符号链接时 `wx` 会失败，而不是照着它写过去。
      this.#fs.writeFileSync(p, '', { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err?.code === 'EEXIST') return { ok: true, why: 'already' };
      // 🔴 **不吞**：投不出去就要让调用方知道（它要把状态说成"还没法给你开"）
      this.#log(`  ⚠️ 申请没投出去（${userId}）：${err?.message ?? err}`);
      return { ok: false, why: 'failed' };
    }
    // ⚠️ 这一行**只有编号**：没有手机号、没有 key（A7）
    this.#log(`  ⏳ 投了一张申请（第 ${userIdNumber(userId)} 号）—— 等特权侧来建那一台`);
    return { ok: true, why: 'asked' };
  }

  /**
   * 有没有**在飞的**申请。
   * ⚠️ 要求是**普通文件**：一个符号链接不算（特权侧也会拒它，但状态不该被它骗着
   *    一直说"正在开"）。
   */
  outstanding(userId) {
    const p = this.#pathFor(userId);
    if (!p) return false;
    try {
      return this.#fs.lstatSync(p).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 特权侧**试过、但没建成** ⇒ 留一个 `<n>.failed` 空标记。
   *
   * 🔴 为什么非要这个标记：申请被消费掉之后，状态就从"正在开"翻到"已经在建"，
   *    而**失败**与**成功**在服务侧看起来**一模一样** —— 于是失败的人会
   *    **永远**停在等待屏上。那就等于在新的这条路上把这次的病**重演了一遍**。
   *
   * ⚠️ **只读"在不在"，不读内容**：标记是 root 写的，但把 root 写的文字直接
   *    渲染给用户看，等于新开一条注入路（`AGENTS.md` §六.1 那条精神）。
   *    为什么失败写在 root 那侧的日志里，不从这儿过。
   */
  failed(userId) {
    const p = this.#pathFor(userId);
    if (!p) return false;
    // ⚠️ 标记在**旁边那个目录**里（见 `DEFAULT_FAILED_DIR`），不在申请目录里 ——
    //    放在申请目录里会让 `.path` 单元反复触发（真机量过）。
    try {
      return this.#fs.lstatSync(nodePath.join(this.#failedDir, `${nodePath.basename(p)}.failed`)).isFile();
    } catch {
      return false;
    }
  }
}
