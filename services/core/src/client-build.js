// 客户端构建指纹的侦测。
//
// 为什么要有这个（两层原因）：
//
// 1. **前端是哑的。** 它只负责"接收和回应"。系统变了、需要新版本才能对上话，
//    它自己不该去猜 —— 由服务端告诉它"你该刷新了"。
//
// 2. **我们真的被这件事坑过。** Service Worker 缓存了旧 main.dart.js，
//    部署了新版本，用户屏幕上还是几小时前的界面。当时靠"自毁式 SW"绕过去了；
//    现在再加一道**正向机制**：服务端能看见当前部署的是哪个构建，
//    发现和用户手上跑的不一样，就让他刷新。
//
// 指纹由 `scripts/deploy-web.sh` 按**客户端源码内容**算出来，
// 写成 `client-build.json` 放在站点根目录。内容不变指纹就不变 ——
// 所以不会有"明明没改却一直让用户刷新"这种事。

import fs from 'node:fs';

export class ClientBuild {
  /**
   * @param {string} file 站点根目录下的 client-build.json
   * @param {{ pollMs?: number, onReload?: (info: object) => void }} [opts]
   */
  constructor(file, { pollMs = 5000, onReload } = {}) {
    this.file = file;
    this.pollMs = pollMs;
    this.onReload = onReload;
    /** 当前部署的构建指纹（文件缺失时为 null）。 */
    this.id = null;
    this.builtAt = null;
    this._timer = null;
    this._read();
  }

  /** 读一次文件；指纹变了就回调。 */
  _read() {
    let next = null;
    let builtAt = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof raw?.buildId === 'string' && raw.buildId) {
        next = raw.buildId;
        builtAt = typeof raw.builtAt === 'string' ? raw.builtAt : null;
      }
    } catch {
      // 文件不在（本地开发、还没部署过）—— 不当作"变了"，静默保持
      return;
    }

    if (next === this.id) return;
    const previous = this.id;
    this.id = next;
    this.builtAt = builtAt;
    // 第一次读只作为基线，不算"刚部署了新版本"
    if (previous !== null) this.onReload?.({ buildId: next, previous, builtAt });
  }

  /** 开始盯着这个文件。 */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._read(), this.pollMs);
    this._timer.unref?.();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /** 给 /api/version 用的快照。 */
  snapshot() {
    return { buildId: this.id, builtAt: this.builtAt };
  }
}
