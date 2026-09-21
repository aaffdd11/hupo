// 监听地址那条**默认必须安全**的闸（契约 `docs/dev/37-MULTITENANT.md`：容器里才绑 0.0.0.0）。
//
// 为什么值得一条单独的闸：这个开关**打开就等于把服务递给整个局域网**。
// 默认值一旦漂了（比如为了"容器方便"默认改成 0.0.0.0），
// 宿主上跑的服务就会**静默对外**——而现场看起来一切正常。
// ⇒ 两条：① 不设就是 127.0.0.1；② 设了真能改（否则它是个死值，闸就没意义）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

test('🔴 不设 HUPO_HOST ⇒ 默认是 127.0.0.1（**不许漂成 0.0.0.0**）', () => {
  const cfg = loadConfig({}, '/tmp');
  assert.equal(cfg.host, '127.0.0.1', '★ 默认绑非回环 = 把服务递给整个局域网');
});

test('负向对照：设了 HUPO_HOST 真能改（盒子里才需要）', () => {
  const cfg = loadConfig({ HUPO_HOST: '0.0.0.0' }, '/tmp');
  assert.equal(cfg.host, '0.0.0.0');
});
