// 事件流落盘。
//
// 契约（手册 `08-SPEC.md` §5.2 的验收 V-a）：
//   1. **写失败必须上抛，绝不吞。**
//      旧实现（`store.js:22-28`）是 `catch { /* 忽略 */ }`——
//      那是**唯一会永久丢数据**的根：盘满了它不报，用户以为发出去了。
//   2. **先落盘成功，调用方才能推订阅者。** 本模块只负责"落"，
//      "推"在 `timeline.js`，且必须在 append 返回之后。
//   3. **append-only，一条一行 JSON。** 不原地改、不重写文件。
//      ⚠️ **唯一的例外是 `rewrite()`（压实）**：它只服务"真删"——见那里的说明。
//      除它之外任何地方都不许重写这条日志。
//   4. **fsync 之后才算落盘**（断电不丢）。可用 `fsync: false` 换速度，
//      但那样"落盘成功"就只是"写进页缓存"。
//
// 为什么 `append` 是**同步**的（不用 await）：
//   "号 = 那条日志已落盘最大 + 1"要求**取号与落盘之间不能插进别的写入**。
//   同步写让这个不变量在语言层面成立，不需要额外加锁。
//   代价：写盘期间阻塞事件循环。数据量上来之后要换成"单写者队列"，
//   但那必须**同时**改取号方式，不能只把 append 改成 async。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 读尾部时最多回看多少字节（找最后一条完整记录） */
const TAIL_BYTES = 64 * 1024;

export class StoreError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'StoreError';
  }
}

export class Store {
  #dataDir;
  #fs;
  #fsync;

  /**
   * @param {object} o
   * @param {string} o.dataDir  日志目录（会被递归创建）
   * @param {object} [o.fs]     注入的文件系统实现（测试用；默认 node:fs）
   * @param {boolean} [o.fsync] 是否 fsync（默认 true）
   */
  constructor({ dataDir, fs = nodeFs, fsync = true }) {
    if (!dataDir) throw new StoreError('dataDir 必填');
    this.#dataDir = dataDir;
    this.#fs = fs;
    this.#fsync = fsync;
    this.#fs.mkdirSync(this.#dataDir, { recursive: true });
  }

  /** 一条可见时间线 = 一条日志（决策 P-l 甲） */
  pathFor(timelineId) {
    if (!/^[A-Za-z0-9_.-]+$/.test(timelineId)) {
      throw new StoreError(`timelineId 含不安全字符：${timelineId}`);
    }
    return nodePath.join(this.#dataDir, `${timelineId}.jsonl`);
  }

  /**
   * 追加一条事件。**失败一律上抛**（见文件头契约 1）。
   *
   * @param {string} timelineId
   * @param {object} event  已经带好 seq 与 at 的完整事件
   */
  append(timelineId, event) {
    const file = this.pathFor(timelineId);
    const line = `${JSON.stringify(event)}\n`;

    let fd;
    let failure = null;
    try {
      fd = this.#fs.openSync(file, 'a');
      this.#fs.writeSync(fd, line, null, 'utf8');
      if (this.#fsync) this.#fs.fsyncSync(fd);
    } catch (err) {
      failure = err;
    }
    // ⚠️ close 的错误**不许掩盖**上面那个真正的失败——掩盖了，
    //    调用方就会以为是"关文件失败"，从而错过"盘满了"这个事实。
    if (fd !== undefined) {
      try {
        this.#fs.closeSync(fd);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure) {
      throw new StoreError(
        `落盘失败（${timelineId}）：${failure?.message ?? failure}`,
        { cause: failure },
      );
    }
  }

  /**
   * 读最后一条已落盘事件。**这是"重启取 max"的依据。**
   *
   * 只读尾部：全量 read+parse 是 O(事件数)，会拖垮启动。
   * 尾块里找不到换行（说明单条记录比尾块还大）⇒ 退化成全量读。
   */
  lastEvent(timelineId) {
    const file = this.pathFor(timelineId);
    let stat;
    try {
      stat = this.#fs.statSync(file);
    } catch (err) {
      if (err?.code === 'ENOENT') return null; // 还没有日志 = 还没有事件
      throw new StoreError(`读取失败（${timelineId}）：${err?.message ?? err}`, { cause: err });
    }
    if (stat.size === 0) return null;

    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    const fd = this.#fs.openSync(file, 'r');
    try {
      this.#fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      this.#fs.closeSync(fd);
    }
    let text = buf.toString('utf8');
    if (start > 0) {
      // 丢掉开头那条可能被截断的记录
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) return this.readAll(timelineId).at(-1) ?? null;
    return this.#parse(lines.at(-1), timelineId);
  }

  /** 全量读（给补发 / 校验用）。坏行直接抛——沉默跳过等于隐瞒数据损坏。 */
  readAll(timelineId) {
    const file = this.pathFor(timelineId);
    let text;
    try {
      text = this.#fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw new StoreError(`读取失败（${timelineId}）：${err?.message ?? err}`, { cause: err });
    }
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => this.#parse(l, timelineId));
  }

  /**
   * 校验编号**严格递增且不跳号**（不变量 N22：磁盘上不得出现空洞）。
   *
   * ⚠️ 只校验**有 seq 的**事件。瞬态事件不落盘（决策 P-g），
   * 所以"盘上没有它们"是**正确**的，不是空洞。
   */
  verifyMonotonic(timelineId) {
    const events = this.readAll(timelineId);
    let prev = 0;
    for (const [i, e] of events.entries()) {
      if (typeof e.seq !== 'number') {
        throw new StoreError(`${timelineId} 第 ${i + 1} 条落了盘却没有 seq：${e.type}`);
      }
      if (e.seq !== prev + 1) {
        throw new StoreError(
          `${timelineId} 编号不连续：第 ${i + 1} 条是 ${e.seq}，上一条是 ${prev}`,
        );
      }
      prev = e.seq;
    }
    return { count: events.length, maxSeq: prev };
  }

  /**
   * ⚠️ **重写整条日志（压实）—— append-only 之外唯一的例外。**
   *
   * 它只服务一件事：**"真删"要让内容真的不在盘上**（契约 `docs/dev/28-DELETE.md` §三）。
   * 只追加是删不掉字节的，所以这里必须重写。
   *
   * 两条不许破：
   *   1. **原子**：先写 `<日志>.tmp` → fsync → `rename` 覆盖。
   *      断电只会看到"旧的"或"新的"，**永远看不到半份**（半份 = 整条时间线没了）。
   *   2. **号一个不跳**：调用方必须让每条事件**带它原来的 `seq`**。
   *      压实是"把内容换成占位"，**不是"抽掉行"** ——
   *      抽行会让 `verifyMonotonic` 变红，也会让"编号 = 已落盘最大 + 1"（N22）失效。
   *
   * @param {string} timelineId
   * @param {object[]} events  完整的新内容（每条都得带 seq）
   */
  rewrite(timelineId, events) {
    const file = this.pathFor(timelineId);
    const tmp = `${file}.tmp`;
    const text = events.map((e) => `${JSON.stringify(e)}\n`).join('');

    let fd;
    let failure = null;
    try {
      fd = this.#fs.openSync(tmp, 'w');
      this.#fs.writeSync(fd, text, null, 'utf8');
      if (this.#fsync) this.#fs.fsyncSync(fd);
    } catch (err) {
      failure = err;
    }
    if (fd !== undefined) {
      try {
        this.#fs.closeSync(fd);
      } catch (err) {
        failure ??= err;
      }
    }
    if (!failure) {
      try {
        this.#fs.renameSync(tmp, file);
      } catch (err) {
        failure = err;
      }
    }
    if (failure) {
      // 尽力把半成品清掉；清不掉也不许掩盖真正的失败
      try {
        this.#fs.unlinkSync(tmp);
      } catch { /* 尽力而为 */ }
      throw new StoreError(
        `压实失败（${timelineId}）：${failure?.message ?? failure}`,
        { cause: failure },
      );
    }
  }

  #parse(line, timelineId) {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new StoreError(`${timelineId} 有一条坏记录：${line.slice(0, 120)}`, { cause: err });
    }
  }
}
