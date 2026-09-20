// 测试用的小工具。**只给测试用**，不是产物。

import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { Store } from '../src/store.js';
import { Timeline } from '../src/timeline.js';

/** 真文件系统上的临时 Store（关掉 fsync，测试快）。 */
export function tempStore() {
  const dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-v2-test-'));
  return { dataDir, store: new Store({ dataDir, fsync: false }) };
}

/** 真文件系统上的时间线。 */
export function tempTimeline(id = 'main', opts = {}) {
  const { dataDir, store } = tempStore();
  return { dataDir, store, timeline: new Timeline({ id, store, ...opts }) };
}

/**
 * 一个"指定动作会失败"的文件系统。
 *
 * @param {object} o
 * @param {'open'|'write'|'fsync'|'close'} [o.at]  在哪一步失败
 * @param {Error} [o.error]  失败时抛什么（默认 ENOSPC）
 * @param {string} [o.existing] 假装已存在的日志内容（用于测试 lastEvent）
 */
export function failingFs({ at = 'write', error, existing = '' } = {}) {
  const boom = () => {
    const e = error ?? new Error('ENOSPC: no space left on device');
    if (!e.code) e.code = 'ENOSPC';
    throw e;
  };
  return {
    mkdirSync: () => {},
    openSync: () => {
      if (at === 'open') boom();
      return 7;
    },
    writeSync: () => {
      if (at === 'write') boom();
    },
    fsyncSync: () => {
      if (at === 'fsync') boom();
    },
    closeSync: () => {
      if (at === 'close') boom();
    },
    statSync: () => ({ size: Buffer.byteLength(existing, 'utf8') }),
    readFileSync: () => existing,
    readSync: (fd, buf) => {
      buf.write(existing, 0, 'utf8');
      return buf.length;
    },
  };
}

/** 收集事件，便于断言"收到/没收到"。 */
export function collector() {
  const got = [];
  return { got, fn: (e) => got.push(e), types: () => got.map((e) => e.type) };
}
